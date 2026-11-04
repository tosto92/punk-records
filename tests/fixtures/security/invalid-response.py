#!/usr/bin/env python3
import json
import os
import sys
from runpy import run_path

response = run_path(os.path.join(os.path.dirname(__file__), 'valid-response.py'))['response']
result = response['results'][0]
mode = os.environ['SECURITY_FIXTURE_MODE']
match = {'ruleId': 'PunkRecordsInstructionOverride', 'ruleName': 'PunkRecordsInstructionOverride',
         'uuid': None, 'category': None, 'severity': None, 'field': 'solution', 'patternIds': ['$english']}
if mode == 'duplicate_identity': response['results'][1] = result.copy()
elif mode == 'missing_identity': response['results'].pop()
elif mode == 'unexpected_identity': result['store'] += '/unexpected'
elif mode == 'wrong_hash': result['contentHash'] = '0' * 64
elif mode == 'wrong_version': response['scanner']['protocolVersion'] = True
elif mode == 'unknown_status': result['status'] = 'safe'
elif mode == 'invalid_match': result.update(status='suspicious', matches=[{'ruleId': 'X'}])
elif mode == 'invalid_field': result.update(status='suspicious', matches=[dict(match, field='not-a-field')])
elif mode == 'invalid_incomplete_rule': result.update(status='incomplete', incompleteRules=[{'ruleId': 'X', 'reason': 'HOSTILE'}])
elif mode == 'missing_incomplete_evidence': result['status'] = 'incomplete'
elif mode == 'clean_with_matches': result['matches'] = [match]
elif mode == 'clean_with_warnings': result['incompleteRules'] = [{'ruleId': 'X', 'reason': 'llm_unavailable'}]
elif mode == 'suspicious_without_matches': result['status'] = 'suspicious'
elif mode == 'error_with_clean': response['errors'] = ['evaluator_error']
elif mode == 'stdout_noise': print('HOSTILE stdout')
elif mode == 'hostile_error': response['errors'] = ['HOSTILE stderr payload']
elif mode == 'scanner_mismatch': result['scanner']['rulesHash'] = '0' * 64
elif mode == 'null_clean_hash': response['scanner']['rulesHash'] = None
sys.stderr.write('HOSTILE stderr payload')
print(json.dumps(response))
