#!/usr/bin/env python3
"""
fetch_sounds.py
從 Freesound 下載遊戲音效
輸出: frontend/public/sounds/
"""
import os, sys, requests, json
sys.stdout.reconfigure(encoding='utf-8')

API_KEY   = '5ErcjAFld2gzMrCfBG5VJvXuwfCgm89ZTsBWCBwJ'
OUT_DIR   = r'C:\Users\USER\Desktop\國考知識\醫師知識王\frontend\public\sounds'

# (filename, search_query, filter, min_dur, max_dur)
SOUNDS = [
    ('correct.mp3',    'correct answer bell chime',      'duration:[0.5 TO 3]',   0.5, 3.0),
    ('wrong.mp3',      'wrong answer buzz error',         'duration:[0.5 TO 3]',   0.5, 3.0),
    ('countdown.mp3',  'clock tick countdown',            'duration:[0.5 TO 2]',   0.3, 2.0),
    ('time_up.mp3',    'time up buzzer horn',             'duration:[0.5 TO 3]',   0.5, 3.0),
    ('victory.mp3',    'victory fanfare short',           'duration:[1 TO 6]',     1.0, 6.0),
    ('defeat.mp3',     'defeat game over sad short',      'duration:[1 TO 5]',     1.0, 5.0),
    ('start.mp3',      'game start jingle short',         'duration:[1 TO 4]',     0.5, 4.0),
    ('coin.mp3',       'coin pickup collect',             'duration:[0.3 TO 2]',   0.3, 2.0),
    ('level_up.mp3',   'level up achievement jingle',     'duration:[1 TO 4]',     1.0, 4.0),
    ('bgm_game.mp3',   'quiz game background music loop', 'duration:[30 TO 180]', 30.0, 180.0),
    ('bgm_lobby.mp3',  'relaxing ambient background loop','duration:[30 TO 180]', 30.0, 180.0),
]

def search_and_download(filename, query, filter_str, min_dur, max_dur):
    out_path = os.path.join(OUT_DIR, filename)
    if os.path.exists(out_path):
        print(f'  [{filename}] 已存在，跳過')
        return True

    print(f'  [{filename}] 搜尋: {query!r}...', end=' ', flush=True)
    try:
        r = requests.get(
            'https://freesound.org/apiv2/search/text/',
            params={
                'query':     query,
                'filter':    filter_str,
                'fields':    'id,name,duration,previews,license',
                'page_size': 20,
                'token':     API_KEY,
            },
            timeout=15,
        )
        r.raise_for_status()
        results = r.json().get('results', [])

        if not results:
            print('無結果')
            return False

        # Pick best match (shortest that meets min_dur for SFX, longest for BGM)
        valid = [x for x in results if min_dur <= x['duration'] <= max_dur]
        if not valid:
            valid = results

        chosen = min(valid, key=lambda x: x['duration']) if min_dur < 5 else max(valid, key=lambda x: x['duration'])
        preview_url = (
            chosen['previews'].get('preview-hq-mp3') or
            chosen['previews'].get('preview-lq-mp3')
        )
        if not preview_url:
            print('無預覽URL')
            return False

        print(f'下載 "{chosen["name"]}" ({chosen["duration"]:.1f}s)...', end=' ', flush=True)
        resp = requests.get(preview_url, timeout=30)
        resp.raise_for_status()
        with open(out_path, 'wb') as f:
            f.write(resp.content)
        print(f'OK ({len(resp.content):,} bytes)')
        return True

    except Exception as e:
        print(f'失敗: {e}')
        return False

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print('=== 下載遊戲音效 from Freesound ===')
    print()

    ok = fail = 0
    for args in SOUNDS:
        if search_and_download(*args):
            ok += 1
        else:
            fail += 1

    print(f'\n完成: {ok} 成功, {fail} 失敗')
    print(f'音效目錄: {OUT_DIR}')

if __name__ == '__main__':
    main()
