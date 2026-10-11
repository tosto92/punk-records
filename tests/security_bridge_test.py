import hashlib
from functools import cache
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / 'lib/security/scan.py'
RULES = ROOT / 'lib/security/rules'
FIXTURES = ROOT / 'tests/fixtures/security'
MEMORIES = json.loads((FIXTURES / 'memories.json').read_text())


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def rule(condition='any of keywords.*', name='Example', stages=''):
    return f'''rule {name}
{{
    meta:
        uuid = "fixture-uuid"
        category = "test"
        severity = "high"
    keywords:
        $a = "alpha"
        $b = "beta"
{stages}
    condition:
        {condition}
}}
'''


def request(texts, rules=None):
    if rules is None:
        manifest = json.loads((RULES / 'manifest.json').read_text())
        rules = [(name, (RULES / name).read_text()) for name in manifest['default']]
    snapshots = [{'name': name, 'content': content, 'sha256': sha(content)} for name, content in rules]
    pairs = sorted([[r['name'], r['sha256']] for r in snapshots])
    rules_hash = sha(json.dumps(pairs, ensure_ascii=False, separators=(',', ':')))
    return {'protocolVersion': 1, 'engineVersion': '0.3.1', 'rulesHash': rules_hash,
            'rules': snapshots, 'items': [{'store': '/fixture/store', 'scope': 'repo',
            'memoryId': 'fixture-memory', 'contentHash': sha(json.dumps(texts)), 'texts': texts}]}


@cache
def load_bridge():
    spec = importlib.util.spec_from_file_location('security_bridge', BRIDGE)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    return bridge


def invoke(payload, env=None):
    if env is None:
        response = load_bridge().scan_batch(payload)
    else:
        process = subprocess.run([sys.executable, str(BRIDGE)], input=json.dumps(payload),
                                 text=True, capture_output=True, env=env, timeout=5)
        if process.returncode:
            raise AssertionError(f'Bridge exited {process.returncode}: {process.stderr}')
        response = json.loads(process.stdout)
    assert set(response) == {'scanner', 'results', 'errors'}, response
    assert len(response['results']) == len(payload['items']), response
    return response


def run_bridge(fixture, rules=None):
    selected = [(rules, (FIXTURES / rules).read_text())] if isinstance(rules, str) else rules
    return invoke(request(MEMORIES[fixture], selected))


class BridgeTests(unittest.TestCase):
    def test_bridge_entrypoint_exists(self):
        self.assertTrue(BRIDGE.is_file(), 'Task 1 bridge is absent')

    def test_stdio_benign_and_attack_roundtrip(self):
        payload = request(MEMORIES['benign_en'])
        attack = request(MEMORIES['override_en'])['items'][0]
        attack['memoryId'] = 'fixture-attack'
        payload['items'].append(attack)
        response = invoke(payload, dict(os.environ))
        self.assertEqual([result['status'] for result in response['results']], ['no_signals', 'suspicious'])
        self.assertTrue(response['results'][1]['matches'])

    def test_default_profile(self):
        for name in ('benign_en', 'benign_it'):
            with self.subTest(name=name):
                self.assertEqual(run_bridge(name)['results'][0]['status'], 'no_signals')
        for name in ('override_en', 'override_it', 'fake_previously_close', 'blanket_approval',
                     'hidden_unicode', 'quoted_attack', 'negated_attack'):
            with self.subTest(name=name):
                result = run_bridge(name)['results'][0]
                self.assertEqual(result['status'], 'suspicious')
                self.assertTrue(result['matches'])
                self.assertEqual(result['incompleteRules'], [])
                self.assertEqual(result['reasonCodes'], [])
                self.assertTrue(any(m['field'] == 'solution' for m in result['matches']))

    def test_field_attribution_and_combined_detection(self):
        result = run_bridge('split_attack')['results'][0]
        self.assertEqual(result['status'], 'suspicious')
        self.assertTrue(any(m['field'] == 'combined' for m in result['matches']))
        self.assertFalse(any(m['field'] in ('title', 'solution') for m in result['matches']))
        match = result['matches'][0]
        self.assertEqual(match['ruleId'], match['ruleName'])
        self.assertTrue(match['patternIds'])

    def test_missing_llm_negated_and_irrelevant_stage(self):
        self.assertEqual(run_bridge('missing_llm_negated', 'conditions.nov')['results'][0]['status'], 'incomplete')
        self.assertEqual(run_bridge('irrelevant_missing_stage', 'conditions.nov')['results'][0]['incompleteRules'], [])

    def test_official_conditions(self):
        semantic = '    semantics:\n        $s = "injection" (0.5)'
        llm = '    llm:\n        $l = "injection" (0.5)'
        cases = [
            ('any of keywords.*', '', 'alpha', 'suspicious'),
            ('any of keywords.*', '', 'gamma', 'no_signals'),
            ('all of keywords.*', '', 'alpha beta', 'suspicious'),
            ('all of keywords.*', '', 'alpha', 'no_signals'),
            ('2 of keywords.*', '', 'alpha beta', 'suspicious'),
            ('2 of keywords.*', '', 'alpha', 'no_signals'),
            ('not keywords.$a', '', 'gamma', 'suspicious'),
            ('not keywords.$a', '', 'alpha', 'no_signals'),
            ('keywords.$a or llm.$l', llm, 'alpha', 'suspicious'),
            ('keywords.$a and llm.$l', llm, 'gamma', 'no_signals'),
            ('keywords.$a or llm.$l', llm, 'gamma', 'incomplete'),
            ('keywords.$a and not llm.$l', llm, 'alpha', 'incomplete'),
            ('keywords.$a or semantics.$s', semantic, 'alpha', 'suspicious'),
            ('keywords.$a and semantics.$s', semantic, 'gamma', 'no_signals'),
            ('keywords.$a or semantics.$s', semantic, 'gamma', 'incomplete'),
            ('not semantics.$s', semantic, 'gamma', 'incomplete'),
            ('keywords.$a or (semantics.$s and llm.$l)', semantic+'\n'+llm, 'alpha', 'suspicious'),
            ('keywords.$a and (semantics.$s or llm.$l)', semantic+'\n'+llm, 'gamma', 'no_signals'),
            ('keywords.$a and (semantics.$s or llm.$l)', semantic+'\n'+llm, 'alpha', 'incomplete'),
            ('any of llm.*', llm, 'gamma', 'incomplete'),
            ('all of semantics.*', semantic, 'gamma', 'incomplete'),
            ('1 of llm.*', llm, 'gamma', 'incomplete'),
        ]
        for condition, stages, text, expected in cases:
            with self.subTest(condition=condition, text=text):
                result = invoke(request([{'field': 'solution', 'text': text}], [('test.nov', rule(condition, stages=stages))]))['results'][0]
                self.assertEqual(result['status'], expected)
                self.assertEqual(bool(result['incompleteRules']), expected == 'incomplete')

    def test_joint_unavailable_stages_cannot_hide_incomplete_analysis(self):
        content = rule('keywords.$a or (semantics.$s and llm.$l)', stages='    semantics:\n        $s = "injection" (0.5)\n    llm:\n        $l = "injection" (0.5)')
        result = run_bridge('joint_missing_stages', [('joint.nov', content)])['results'][0]
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(result['incompleteRules'], [{'ruleId':'Example', 'reason':'unavailable_condition'}])

    def test_joint_unavailable_positive_is_not_a_definite_match(self):
        content = rule('not (semantics.$s and llm.$l)', stages='    semantics:\n        $s = "injection" (0.5)\n    llm:\n        $l = "injection" (0.5)')
        result = run_bridge('joint_missing_stages', [('joint.nov', content)])['results'][0]
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(result['matches'], [])
        self.assertEqual(result['incompleteRules'], [{'ruleId':'Example', 'reason':'unavailable_condition'}])

    def test_completeness_probe_is_bounded(self):
        stages = '    semantics:\n'+''.join(f'        $s{i} = "injection" (0.5)\n' for i in range(5))
        stages += '    llm:\n'+''.join(f'        $l{i} = "injection" (0.5)\n' for i in range(4))
        content = rule('keywords.$a or (all of semantics.* and all of llm.*)', stages=stages)
        result = run_bridge('joint_missing_stages', [('cap.nov', content)])['results'][0]
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(result['incompleteRules'], [{'ruleId':'Example', 'reason':'condition_probe_limit'}])

    def test_definite_match_retains_separate_incomplete_evidence(self):
        rules = [('match.nov', rule(name='Match')), ('missing.nov', rule('not llm.$l', 'Missing', '    llm:\n        $l = "injection" (0.5)'))]
        result = invoke(request([{'field': 'solution', 'text': 'alpha'}], rules))['results'][0]
        self.assertEqual(result['status'], 'suspicious')
        self.assertEqual({m['ruleId'] for m in result['matches']}, {'Match'})
        self.assertEqual({m['ruleId'] for m in result['incompleteRules']}, {'Missing'})

    def test_invalid_rules_and_identity_are_incomplete(self):
        cases = [([], 'empty_rules'),
                 ([('bad.nov', 'not a rule')], 'rules_parse_error'),
                 ([('bad.nov', rule().replace('"alpha"', '/[/'))], 'rules_parse_error'),
                 ([('bad.nov', rule().replace('any of keywords.*', 'keywords.$undefined'))], 'rules_parse_error'),
                 ([('one.nov', rule()), ('two.nov', rule())], 'duplicate_rule_name'),
                 ([('one.nov', rule()), ('one.nov', rule(name='Other'))], 'duplicate_rule_file')]
        for rules, code in cases:
            with self.subTest(code=code):
                report = invoke(request(MEMORIES['benign_en'], rules))
                self.assertIn(code, report['errors'])
                self.assertEqual(report['results'][0]['status'], 'incomplete')
        for field, value, code in [('engineVersion', '0.0.0', 'engine_version_mismatch'),
                                   ('protocolVersion', 2, 'protocol_version_mismatch'),
                                   ('rulesHash', '0'*64, 'rules_hash_mismatch')]:
            payload = request(MEMORIES['benign_en'], [('one.nov', rule())]); payload[field] = value
            self.assertIn(code, invoke(payload)['errors'])
        payload = request(MEMORIES['benign_en'], [('one.nov', rule())]); payload['rules'][0]['content'] += '\n'
        self.assertIn('rule_hash_mismatch', invoke(payload)['errors'])

    def test_rule_file_envelope_rejects_unparsed_content(self):
        for tail in ('\nrule ??? {\n keywords:\n $x = "x"\n condition:\n $x\n}',
                     '\nthis is trailing garbage',
                     '\nrule Broken {\n keywords:\n $x = "x"'):
            with self.subTest(tail=tail):
                report = invoke(request(MEMORIES['benign_en'], [('test.nov', rule()+tail)]))
                self.assertIn('rules_parse_error', report['errors'])
        content = '# before\n// before\n'+rule()+'\n# after\n// after\n'
        self.assertEqual(invoke(request(MEMORIES['benign_en'], [('test.nov', content)]))['results'][0]['status'], 'no_signals')

    def test_installed_engine_version_is_checked(self):
        bridge = load_bridge()
        payload = request(MEMORIES['benign_en'], [('test.nov', rule())])
        with patch.object(bridge.importlib.metadata, 'version', return_value='0.3.0'):
            self.assertEqual(bridge.scan_batch(payload)['errors'], ['engine_version_mismatch'])
        with patch.object(bridge.importlib.metadata, 'version', side_effect=importlib.metadata.PackageNotFoundError):
            self.assertEqual(bridge.scan_batch(payload)['errors'], ['engine_unavailable'])

    def test_malformed_request_and_boolean_protocol_fail_closed(self):
        payload = request(MEMORIES['benign_en'], [('one.nov', rule())])
        payload['protocolVersion'] = True
        self.assertEqual(invoke(payload)['errors'], ['protocol_version_mismatch'])

    def test_malformed_item_fails_the_batch_closed(self):
        payload = request(MEMORIES['benign_en'], [('one.nov', rule())])
        payload['items'].append(None)
        process = subprocess.run([sys.executable, str(BRIDGE)], input=json.dumps(payload), text=True, capture_output=True, timeout=5)
        self.assertEqual(process.returncode, 0)
        report = json.loads(process.stdout)
        self.assertIn('invalid_request', report['errors'])
        self.assertTrue(all(result['status'] == 'incomplete' for result in report['results']))

    def test_empty_store_still_reports_errors(self):
        payload = request([], []); payload['items'] = []
        self.assertEqual(invoke(payload)['errors'], ['empty_rules'])

    def test_upstream_bundle_hashes_and_mixed_stage(self):
        manifest = json.loads((RULES / 'manifest.json').read_text())
        self.assertEqual(manifest['upstreamCommit'], '3cee07e073c949bd00a8445a6eb2fd57a03ce1d2')
        self.assertNotIn('upstream/hidden_unicode.nov', manifest['default'])
        self.assertEqual(manifest['sha256']['upstream/claude_magic_string.nov'], '8b098b1e2016c894571769b4fb073f02f7a1c37e4ed1a1ad7a25d3d4216200b5')
        self.assertEqual(manifest['sha256']['upstream/delimiter_termination_probe.nov'], 'd695b2da32bed66fc6211314dc3ce8ba3d818b80c5d6d4549ed3807359d2c848')
        self.assertEqual(manifest['sha256']['upstream/hidden_unicode.nov'], 'b191656b7bcdb259f089d433d63d9137c928de84be91fd6041cc635d263e8668')
        self.assertEqual(manifest['sha256']['upstream/LICENSE'], 'a8bcc4903a4c0a3f7946a7519af0df20fa00f09258a64bff54c390f0bd7ff8dd')
        for name, expected in manifest['sha256'].items():
            self.assertEqual(hashlib.sha256((RULES / name).read_bytes()).hexdigest(), expected)
        rules = [('hidden.nov', (RULES / 'upstream/hidden_unicode.nov').read_text())]
        self.assertEqual(run_bridge('benign_en', rules)['results'][0]['status'], 'incomplete')
        self.assertEqual(run_bridge('hidden_unicode', rules)['results'][0]['status'], 'suspicious')

    def test_disabled_evaluators_never_autoload_or_connect(self):
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory)
            for name in ('openai', 'anthropic', 'groq', 'sentence_transformers', 'transformers', 'torch'):
                (sentinel / (name+'.py')).write_text('from pathlib import Path\nPath(__file__).with_name("calls").write_text("optional provider imported")\nraise AssertionError("optional provider imported")\n')
            (sentinel / 'sitecustomize.py').write_text("""import socket, importlib.abc, sys, os
from pathlib import Path
marker = Path(__file__).with_name('calls')
def blocked(*args, **kwargs):
    marker.write_text('unexpected evaluator or network call')
    raise AssertionError('offline boundary crossed')
socket.socket.connect = blocked
socket.create_connection = blocked
original_get = os.environ.get
def guarded_get(key, default=None):
    if key in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY'):
        return blocked()
    return original_get(key, default)
os.environ.get = guarded_get
from nova.evaluators import llm
for name in llm.__all__:
    value = getattr(llm, name)
    if isinstance(value, type) and name.endswith('Evaluator'):
        value.__init__ = blocked
import nova.core.matcher as matcher
matcher._get_semantic_evaluator_class = blocked
matcher._get_llm_evaluator_classes = blocked
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'nova.evaluators.semantics':
            return blocked()
sys.meta_path.insert(0, Block())
Path(__file__).with_name('ready').write_text('ready')
""")
            env = dict(os.environ, PYTHONPATH=directory, OPENAI_API_KEY='fixture-dummy', ANTHROPIC_API_KEY='fixture-dummy', GROQ_API_KEY='fixture-dummy')
            rules = [('mixed.nov', rule('keywords.$a or (semantics.$s and llm.$l)', stages='    semantics:\n        $s = "injection" (0.5)\n    llm:\n        $l = "injection" (0.5)'))]
            for text, expected in [('alpha', 'suspicious'), ('gamma', 'incomplete')]:
                result = invoke(request([{'field':'solution','text':text}], rules), env)['results'][0]
                self.assertEqual(result['status'], expected)
                self.assertTrue((sentinel / 'ready').exists(), 'sentinel setup must finish')
                self.assertFalse((sentinel / 'calls').exists(), 'offline evaluator/network sentinel called')


if __name__ == '__main__':
    unittest.main()
