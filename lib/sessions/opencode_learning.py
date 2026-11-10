#!/usr/bin/env python3
"""Bounded, read-only OpenCode native session acquisition (V1 and V2)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
from datetime import datetime, timezone

MAX_JSON = 32 * 1024 * 1024
MAX_ROWS = 100000
METADATA = {'agent-switched', 'model-switched', 'system', 'skill', 'synthetic', 'compaction'}
EXCLUDED = {'reasoning', 'file', 'image', 'audio', 'snapshot', 'patch', 'agent', 'subtask', 'retry', 'compaction', 'step-start', 'step-finish'}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def decode(raw):
    try:
        value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise ValueError('malformed native JSON; selected session cannot be captured') from None


def columns(connection, table):
    return {r[1] for r in connection.execute('PRAGMA table_info(' + table + ')')}


def schema(connection, version):
    tables = ({'session_v2': {'id', 'directory', 'time_updated'},
               'session_message': {'id', 'session_id', 'type', 'seq', 'time_created', 'data'},
               'session_part': {'message_id', 'session_id', 'ordinal', 'type', 'call_id', 'data'}} if version == 2 else
              {'session': {'id', 'directory', 'time_updated'},
               'message': {'id', 'session_id', 'time_created', 'data'},
               'part': {'id', 'message_id', 'session_id', 'data'}})
    if any(not needed <= columns(connection, table) for table, needed in tables.items()):
        raise ValueError('unsupported OpenCode schema; use a supported native database')


def rows(connection, query, params=()):
    cursor = connection.execute(query, params)
    names = [c[0] for c in cursor.description]
    for row in cursor:
        yield dict(zip(names, row))


def descriptor(connection, row, version):
    database = next((r[2] for r in connection.execute('PRAGMA database_list') if r[1] == 'main'), '')
    return {'sessionId': row['id'], 'database': str(Path(database).resolve()) if database else '',
            'sourceAgent': 'opencode', 'storageFormat': 'opencode-v' + str(version),
            'readerFormatVersion': 1, 'directory': row['directory'], 'parentId': row.get('parent_id'),
            'title': row.get('title'), 'updatedAt': row['time_updated'], 'revert': bool(row.get('revert')),
            'forkSessionId': row.get('fork_session_id'), 'forkBoundary': row.get('fork_boundary')}


def native_sessions(connection):
    """Enumerate identities; an authoritative V2 identity always wins."""
    seen = set()
    found = False
    for version, table in [(2, 'session_v2'), (1, 'session')]:
        if not columns(connection, table):
            continue
        found = True
        if not {'id', 'directory', 'time_updated'} <= columns(connection, table):
            raise ValueError('unsupported OpenCode session schema')
        for row in rows(connection, 'SELECT * FROM ' + table + ' ORDER BY id'):
            if row['id'] not in seen:
                seen.add(row['id'])
                yield descriptor(connection, row, version)
    if not found:
        raise ValueError('unsupported OpenCode schema; native session tables missing')


def selected_rows(connection, desc):
    version = 2 if desc['storageFormat'] == 'opencode-v2' else 1
    schema(connection, version)
    mt, pt = ('session_message', 'session_part') if version == 2 else ('message', 'part')
    sid = desc['sessionId']
    # Count bytes before fetching JSON: unrelated sessions never consume this budget.
    count = size = 0
    for table in [mt, pt]:
        n, b = connection.execute('SELECT COUNT(*), COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM ' + table + ' WHERE session_id=?', (sid,)).fetchone()
        count += n
        size += b
    if count > MAX_ROWS:
        raise ValueError('native row limit exceeded for selected session')
    if size > MAX_JSON:
        raise ValueError('selected native JSON limit exceeded (32 MiB)')
    messages = list(rows(connection, 'SELECT * FROM ' + mt + ' WHERE session_id=? ORDER BY ' + ('seq' if version == 2 else 'time_created,id'), (sid,)))
    parts = list(rows(connection, 'SELECT * FROM ' + pt + ' WHERE session_id=? ORDER BY ' + ('message_id,ordinal' if version == 2 else 'id'), (sid,)))
    ids = {m['id'] for m in messages}
    if len(ids) != len(messages) or (version == 2 and len({m['seq'] for m in messages}) != len(messages)):
        raise ValueError('ambiguous native message order')
    for part in parts:
        if part['message_id'] not in ids:
            raise ValueError('dangling native part relationship')
    cross = connection.execute('SELECT 1 FROM ' + pt + ' p JOIN ' + mt + ' m ON p.message_id=m.id WHERE m.session_id=? AND p.session_id!=? LIMIT 1', (sid, sid)).fetchone()
    if cross:
        raise ValueError('cross-session native part relationship')
    if version == 1 and len({p['id'] for p in parts}) != len(parts):
        raise ValueError('ambiguous native part order')
    if version == 2:
        if any(type(m['seq']) is not int for m in messages) or len({(p['message_id'], p['ordinal']) for p in parts}) != len(parts):
            raise ValueError('ambiguous native content order')
    for item in messages + parts:
        item['data'] = decode(item['data'])
        data = item['data']
        if data.get('sessionID', sid) != sid or ('message_id' in item and data.get('messageID', item['message_id']) != item['message_id']):
            raise ValueError('cross-session native JSON relationship')
    return messages, parts


def native_prompts(connection, desc):
    messages, parts = selected_rows(connection, desc)
    for message in messages:
        data = message['data']
        if desc['storageFormat'] == 'opencode-v2':
            if message['type'] != 'user' or data.get('synthetic') or data.get('ignored'):
                continue
            text = data.get('text', '')
        else:
            if data.get('role') != 'user':
                continue
            text = '\n'.join(p['data'].get('text', '') for p in parts if p['message_id'] == message['id'] and p['data'].get('type') == 'text' and not p['data'].get('synthetic') and not p['data'].get('ignored'))
        if not isinstance(text, str):
            raise ValueError('unsupported native prompt text')
        if text.strip() and not text.strip().startswith('/'):
            yield {'ts': message['time_created'] / 1000, 'text': text.strip()}


def timestamp(value):
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    except (ValueError, TypeError, OverflowError):
        raise ValueError('unsupported native timestamp') from None


def capture_session(database, session_id):
    file = Path(database).absolute()
    try:
        info = file.lstat()
    except OSError:
        raise ValueError('OpenCode database not found or unreadable; select --database') from None
    if not stat.S_ISREG(info.st_mode) or file.is_symlink():
        raise ValueError('OpenCode database must be a regular non-symlink file')
    file = file.resolve()
    connection = sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA busy_timeout=2000')
        connection.execute('BEGIN')
        desc = None
        found_tables = False
        for version, table in [(2, 'session_v2'), (1, 'session')]:
            available = columns(connection, table)
            if not available:
                continue
            found_tables = True
            if 'id' not in available:
                raise ValueError('unsupported OpenCode session schema')
            native = next(rows(connection, 'SELECT * FROM ' + table + ' WHERE id=?', (session_id,)), None)
            if native is not None:
                if not {'id', 'directory', 'time_updated'} <= available:
                    raise ValueError('unsupported OpenCode session schema')
                desc = descriptor(connection, native, version)
                break
        if not found_tables:
            raise ValueError('unsupported OpenCode schema; native session tables missing')
        if desc is None:
            raise ValueError('OpenCode session not found; select an exact native session ID')
        messages, parts = selected_rows(connection, desc)
        table = 'session_v2' if desc['storageFormat'] == 'opencode-v2' else 'session'
        native = next(rows(connection, 'SELECT * FROM ' + table + ' WHERE id=?', (session_id,)))
        revision = hashlib.sha256(canonical([native, messages, parts]).encode()).hexdigest()
    finally:
        connection.close()
    return project(desc, messages, parts, revision)


def project(desc, messages, parts, revision):
    records, pending = [], []
    exclusions = {}
    held_reason = None
    boundary = 0
    blocked = None
    emitted_bytes = 0
    version = desc['storageFormat']
    by_message = {}
    for part in parts:
        by_message.setdefault(part['message_id'], []).append(part)
    coverage = {'sourceComplete': True, 'deferredFrom': None, 'reason': None, 'heldMessages': 0, 'exclusions': exclusions}
    if desc.get('revert') or desc.get('forkSessionId') or desc.get('forkBoundary'):
        held_reason = 'fork/revert history cannot be interpreted safely'

    def exclude(kind):
        exclusions[kind] = exclusions.get(kind, 0) + 1

    def emit(message, role, text, locator, **metadata):
        nonlocal emitted_bytes
        if not isinstance(text, str):
            raise ValueError('unsupported native visible text')
        if text.strip():
            record = {'role': role, 'text': text, 'timestamp': timestamp(message.get('time_created')),
                      'locator': {'sessionId': desc['sessionId'], 'messageId': message['id'], **locator}, **metadata}
            emitted_bytes += len(canonical(record).encode()) + 1
            if emitted_bytes > MAX_JSON:
                raise ValueError('canonical projection limit exceeded (32 MiB)')
            pending.append(record)

    def content(message, item, locator):
        nonlocal blocked
        if not isinstance(item, dict):
            raise ValueError('unsupported native content shape')
        kind = item.get('type')
        if item.get('synthetic') or item.get('ignored'):
            exclude('synthetic' if item.get('synthetic') else 'ignored')
        elif kind in EXCLUDED:
            exclude(kind)
        elif kind == 'text':
            emit(message, message.get('type', message['data'].get('role')), item.get('text', ''), locator)
        elif kind == 'tool':
            state = item.get('state')
            if not isinstance(state, dict):
                raise ValueError('unsupported native tool state')
            status = state.get('status')
            if status in {'pending', 'running', 'streaming'}:
                blocked = 'pending native tool'
                return
            if status not in {'completed', 'error'}:
                raise ValueError('unsupported native tool status')
            if (state.get('time') or {}).get('compacted') or state.get('compacted'):
                exclude('compacted-tool')
                emit(message, 'tool', '[compacted tool output unavailable]', locator, toolName=item.get('tool', item.get('name')), toolStatus=status, unavailable=True)
                return
            text = state.get('output', '')
            if version == 'opencode-v2':
                outputs = state.get('content', [])
                if not isinstance(outputs, list):
                    raise ValueError('unsupported native tool content')
                values = []
                for output in outputs:
                    if not isinstance(output, dict):
                        raise ValueError('unsupported native tool content shape')
                    if output.get('type') == 'text' and not output.get('synthetic') and not output.get('ignored'):
                        values.append(output.get('text', ''))
                    elif output.get('type') in EXCLUDED:
                        exclude(output['type'])
                    else:
                        raise ValueError('unsupported native tool content type')
                text = '\n'.join(values)
            error = state.get('error')
            if error:
                text = (text + '\n' if text else '') + (error if isinstance(error, str) else canonical(error))
            metadata = {'toolName': item.get('tool', item.get('name')), 'toolStatus': status}
            exit_code = (state.get('metadata') or {}).get('exit')
            if exit_code is not None:
                if type(exit_code) is not int:
                    raise ValueError('unsupported native tool exit code')
                metadata['exitCode'] = exit_code
            emit(message, 'tool', text, locator, **metadata)
        else:
            raise ValueError('unsupported native content type')

    for index, message in enumerate(messages):
        data = message['data']
        kind = message.get('type', data.get('role'))
        if version == 'opencode-v2':
            if kind != 'assistant' and by_message.get(message['id']):
                blocked = 'unreconciled native part projection'
            if kind in METADATA:
                exclude(kind)
                continue
            if kind == 'location-switched':
                blocked = 'location-switched history cannot be interpreted safely'
            elif kind == 'user':
                if data.get('synthetic') or data.get('ignored'):
                    exclude('synthetic' if data.get('synthetic') else 'ignored')
                else:
                    emit(message, 'user', data.get('text', ''), {'kind': 'text'})
                for attachment in data.get('files', []):
                    exclude('file')
            elif kind == 'assistant':
                contents = data.get('content')
                if not isinstance(contents, list):
                    raise ValueError('unsupported native assistant content')
                if any(not isinstance(item, dict) for item in contents):
                    raise ValueError('unsupported native content shape')
                for part in by_message.get(message['id'], []):
                    ordinal = part['ordinal']
                    if type(ordinal) is not int or ordinal < 0 or ordinal >= len(contents) or canonical(part['data']) != canonical(contents[ordinal]) or part['type'] != contents[ordinal].get('type') or part.get('call_id') != (contents[ordinal].get('id') if contents[ordinal].get('type') == 'tool' else None):
                        blocked = 'unreconciled native part projection'
                if data.get('summary'):
                    exclude('compaction-summary')
                for ordinal, item in enumerate([] if data.get('summary') else contents):
                    locator = {'kind': item.get('type'), 'ordinal': ordinal}
                    if item.get('type') == 'tool':
                        locator['toolCallId'] = item.get('id')
                    content(message, item, locator)
                if not (data.get('time') or {}).get('completed'):
                    blocked = 'incomplete native assistant'
            elif kind == 'shell':
                status = data.get('status')
                if status not in {'running', 'exited', 'timeout', 'killed'}:
                    raise ValueError('unsupported native shell status')
                if status == 'running' or not (data.get('time') or {}).get('completed'):
                    blocked = 'pending native shell'
                else:
                    output = data.get('output') or {}
                    metadata = {'toolName': 'shell', 'toolStatus': status,
                                'outputMetadata': {key: output[key] for key in ('cursor', 'size', 'truncated') if key in output}}
                    if data.get('exit') is not None:
                        if type(data['exit']) is not int:
                            raise ValueError('unsupported native shell exit code')
                        metadata['exitCode'] = data['exit']
                    emit(message, 'tool', output.get('output', ''), {'kind': 'shell'}, **metadata)
            elif kind == 'idle':
                outcome = data.get('outcome')
                if outcome not in {'succeeded', 'failed', 'interrupted'}:
                    raise ValueError('unsupported native idle outcome')
                if not blocked and not held_reason:
                    for record in pending:
                        record['outcome'] = outcome
                    records.extend(pending)
                    pending = []
                    boundary = index + 1
            else:
                raise ValueError('unsupported native message type')
        else:
            if kind not in {'user', 'assistant'}:
                raise ValueError('unsupported native message role')
            if kind == 'user' and pending:
                blocked = blocked or 'missing final native completion'
            if kind == 'assistant' and data.get('summary'):
                exclude('compaction-summary')
            for part in ([] if data.get('summary') else by_message.get(message['id'], [])):
                locator = {'kind': part['data'].get('type'), 'partId': part['id']}
                if part['data'].get('type') == 'tool':
                    locator['toolCallId'] = part['data'].get('callID')
                content(message, part['data'], locator)
            if kind == 'assistant':
                completed = (data.get('time') or {}).get('completed')
                finish, error = data.get('finish'), data.get('error')
                if completed and (finish in {'stop', 'length', 'content-filter'} or error) and not blocked and not held_reason:
                    for record in pending:
                        record['finish'] = finish
                        if error:
                            record['outcome'] = 'failed'
                    records.extend(pending)
                    pending = []
                    boundary = index + 1
        if blocked and not held_reason:
            held_reason = blocked
    if held_reason or pending or boundary < len(messages) and any(m.get('type') not in METADATA for m in messages[boundary:]):
        coverage.update(sourceComplete=False, deferredFrom={'sessionId': desc['sessionId'], 'messageId': messages[boundary]['id']} if messages else None,
                        reason=held_reason or 'missing final native completion', heldMessages=len(messages) - boundary)
    projection_hash = hashlib.sha256()
    projection_bytes = 0
    for record in records:
        encoded = (canonical(record) + '\n').encode()
        projection_bytes += len(encoded)
        if projection_bytes > MAX_JSON:
            raise ValueError('canonical projection limit exceeded (32 MiB)')
        projection_hash.update(encoded)
    desc['projectionSha256'] = projection_hash.hexdigest()
    return {'records': records, 'descriptor': desc, 'sourceRevision': revision, 'coverage': coverage}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['capture'])
    parser.add_argument('session_id')
    parser.add_argument('--database', default=str(Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share') / 'opencode/opencode.db'))
    args = parser.parse_args()
    try:
        print(canonical(capture_session(args.database, args.session_id)))
    except (ValueError, sqlite3.Error, OSError, TypeError, KeyError, AttributeError, UnicodeError, RecursionError):
        error = sys.exc_info()[1]
        message = str(error) if isinstance(error, ValueError) else 'native database capture failed; check schema and read access'
        print('OpenCode capture: ' + message, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
