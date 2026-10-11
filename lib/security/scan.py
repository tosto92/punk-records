"""Pinned, offline NOVA execution over rule snapshots supplied by Node."""
import contextlib
import hashlib
import importlib.metadata
import json
from itertools import product
import sys

ENGINE_VERSION = '0.3.1'
PROTOCOL_VERSION = 1


class UnavailableEvaluator:
    def evaluate(self, *args, **kwargs):
        raise RuntimeError('semantic_unavailable')

    def evaluate_prompt(self, *args, **kwargs):
        raise RuntimeError('llm_unavailable')


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def scan_batch(request: dict) -> dict:
    scanner = {'engineVersion': ENGINE_VERSION, 'protocolVersion': PROTOCOL_VERSION, 'rulesHash': None}
    report = {'scanner': scanner, 'results': [], 'errors': []}
    items = request.get('items', []) if isinstance(request, dict) else []
    if not isinstance(items, list):
        items = []
    for item in items:
        if not isinstance(item, dict):
            report['errors'].append('invalid_request')
            continue
        report['results'].append({key: item.get(key) for key in ('store', 'scope', 'memoryId', 'contentHash')})
        report['results'][-1].update(scanner=scanner, status='incomplete', matches=[], incompleteRules=[], reasonCodes=[])

    def fail(code):
        if code not in report['errors']:
            report['errors'].append(code)
        for result in report['results']:
            result['reasonCodes'] = list(report['errors'])
        return report

    if report['errors'] or not isinstance(request, dict) or not isinstance(request.get('items'), list):
        return fail('invalid_request')
    if type(request.get('protocolVersion')) is not int or request['protocolVersion'] != PROTOCOL_VERSION:
        return fail('protocol_version_mismatch')
    if request.get('engineVersion') != ENGINE_VERSION:
        return fail('engine_version_mismatch')
    try:
        if importlib.metadata.version('nova-hunting') != ENGINE_VERSION:
            return fail('engine_version_mismatch')
    except importlib.metadata.PackageNotFoundError:
        return fail('engine_unavailable')
    snapshots = request.get('rules')
    if not isinstance(snapshots, list):
        return fail('invalid_request')
    if not snapshots:
        return fail('empty_rules')
    names = set()
    for snapshot in snapshots:
        if not isinstance(snapshot, dict) or not all(isinstance(snapshot.get(k), str) for k in ('name', 'sha256', 'content')):
            return fail('invalid_request')
        if snapshot['name'] in names:
            return fail('duplicate_rule_file')
        names.add(snapshot['name'])
        if digest(snapshot['content']) != snapshot['sha256']:
            return fail('rule_hash_mismatch')
    pairs = sorted([[r['name'], r['sha256']] for r in snapshots])
    rules_hash = digest(json.dumps(pairs, ensure_ascii=False, separators=(',', ':')))
    if request.get('rulesHash') != rules_hash:
        return fail('rules_hash_mismatch')
    scanner['rulesHash'] = rules_hash
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from nova.core.rule_file import NovaRuleFileParser
            from nova.core.matcher import NovaMatcher
            from nova.evaluators.condition import evaluate_condition
            parser = NovaRuleFileParser()
            rules = []
            for snapshot in snapshots:
                content = snapshot['content']
                # The official parser ignores text outside extracted blocks; reject partial files.
                offset = 0
                for block in parser._extract_rule_blocks_optimized(content):
                    start = content.find(block, offset)
                    if not all(parser.rule_parser._is_comment_or_blank(line) for line in content[offset:start].splitlines()):
                        return fail('rules_parse_error')
                    offset = start + len(block)
                if not all(parser.rule_parser._is_comment_or_blank(line) for line in content[offset:].splitlines()):
                    return fail('rules_parse_error')
                rules.extend(parser.parse_content(content, snapshot['name']))
    except Exception:
        return fail('rules_parse_error')
    if len({rule.name for rule in rules}) != len(rules):
        return fail('duplicate_rule_name')
    try:
        with contextlib.redirect_stdout(sys.stderr):
            unavailable = UnavailableEvaluator()
            matchers = [NovaMatcher(rule, semantic_evaluator=unavailable,
                        llm_evaluator=unavailable, create_llm_evaluator=False) for rule in rules]
    except Exception:
        return fail('evaluator_error')

    for item, result in zip(items, report['results']):
        texts = item.get('texts')
        if not isinstance(texts, list) or not texts or not all(
                isinstance(t, dict) and isinstance(t.get('field'), str) and isinstance(t.get('text'), str) for t in texts):
            result['reasonCodes'] = ['invalid_item']
            continue
        if sum(len(t['text']) for t in texts) > 50000:
            result['reasonCodes'] = ['memory_too_large']
            continue
        fields = texts + [{'field': 'combined', 'text': '\n'.join(t['text'] for t in texts)}]
        incomplete = set()
        for matcher in matchers:
            rule = matcher.rule
            for field in fields:
                try:
                    with contextlib.redirect_stdout(sys.stderr):
                        evidence = matcher.check_prompt(field['text'])
                    warnings = evidence.get('debug', {}).get('evaluation_warnings', [])
                    for warning in warnings:
                        reason = ('semantic_unavailable' if 'semantics.' in warning or 'semantic evaluation' in warning
                                  else 'llm_unavailable' if 'llm.' in warning or 'LLM' in warning
                                  else 'evaluator_error')
                        incomplete.add((rule.name, reason))
                    missing = [('semantics', key) for key in rule.semantics] + [('llm', key) for key in rule.llms]
                    if not warnings and missing:
                        # shortcut: probe at most 256 assignments, larger rules require a future proof strategy.
                        if len(missing) > 8:
                            incomplete.add((rule.name, 'condition_probe_limit'))
                            continue
                        determinate = True
                        for values in product((False, True), repeat=len(missing)):
                            assignments = dict(zip(missing, values))
                            try:
                                with contextlib.redirect_stdout(sys.stderr):
                                    outcome = evaluate_condition(rule.condition, evidence['debug']['all_keyword_matches'],
                                        {key: assignments[('semantics', key)] for key in rule.semantics},
                                        {key: assignments[('llm', key)] for key in rule.llms})
                            except Exception:
                                determinate = False
                                break
                            if outcome != evidence['matched']:
                                determinate = False
                                break
                        if not determinate:
                            incomplete.add((rule.name, 'unavailable_condition'))
                            continue
                    if evidence['matched'] and not warnings:
                        result['matches'].append({'ruleId': rule.name, 'ruleName': rule.name,
                            'uuid': rule.meta.get('uuid'), 'category': rule.meta.get('category'),
                            'severity': rule.meta.get('severity'), 'field': field['field'],
                            'patternIds': sorted(key for section in ('matching_keywords', 'matching_semantics', 'matching_llm')
                                                 for key in evidence.get(section, {}))})
                except Exception:
                    incomplete.add((rule.name, 'evaluator_error'))
        result['incompleteRules'] = [{'ruleId': name, 'reason': reason} for name, reason in sorted(incomplete)]
        result['status'] = 'suspicious' if result['matches'] else 'incomplete' if incomplete else 'no_signals'
    return report


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
    except (ValueError, UnicodeError):
        request = None
    with contextlib.redirect_stdout(sys.stderr):
        response = scan_batch(request)
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(',', ':'))
    sys.stdout.write('\n')
