#!/usr/bin/env python3
import json
import sys

request = json.load(sys.stdin)
scanner = {key: request[key] for key in ('engineVersion', 'protocolVersion', 'rulesHash')}
response = {'scanner': scanner, 'errors': [], 'results': []}
for item in request['items']:
    result = {key: item[key] for key in ('store', 'scope', 'memoryId', 'contentHash')}
    result.update(scanner=scanner.copy(), status='no_signals', matches=[], incompleteRules=[], reasonCodes=[])
    response['results'].append(result)
if __name__ == '__main__':
    print(json.dumps(response))
