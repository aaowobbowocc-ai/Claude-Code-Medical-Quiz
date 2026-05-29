"""
Vertex Gemini 2.5 Flash Image (Nano Banana) batch generator.

Uses ADC (Application Default Credentials). Set up once with:
  gcloud auth application-default login

Usage:
  python gen-vertex-image.py "prompt text" --output path/to/out.png
  python gen-vertex-image.py "prompt" --output out.png --model imagen-4.0-generate-001

Cost: Nano Banana ~$0.039/image, Imagen 4 ~$0.04/image.
"""
import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error

from google.auth import default
from google.auth.transport.requests import Request

PROJECT = os.environ.get('VERTEX_PROJECT', 'gen-lang-client-0502672630')
LOCATION = os.environ.get('VERTEX_REGION', 'us-central1')


def get_token():
    creds, _ = default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    creds.refresh(Request())
    return creds.token


def gen_nano_banana(prompt, output):
    """Gemini 2.5 Flash Image (Nano Banana) — best for character consistency."""
    model = 'gemini-2.5-flash-image'
    url = (
        f'https://{LOCATION}-aiplatform.googleapis.com/v1/'
        f'projects/{PROJECT}/locations/{LOCATION}/'
        f'publishers/google/models/{model}:generateContent'
    )
    body = {
        'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
        'generationConfig': {
            'responseModalities': ['IMAGE'],
            'temperature': 0.9,
        },
    }
    return _post_and_save(url, body, output, fmt='gemini')


def gen_imagen(prompt, output, model='imagen-4.0-generate-001'):
    """Imagen 4 — alternative path if Nano Banana not available."""
    url = (
        f'https://{LOCATION}-aiplatform.googleapis.com/v1/'
        f'projects/{PROJECT}/locations/{LOCATION}/'
        f'publishers/google/models/{model}:predict'
    )
    body = {
        'instances': [{'prompt': prompt}],
        'parameters': {
            'sampleCount': 1,
            'aspectRatio': '1:1',
            'safetySetting': 'block_only_high',
            'personGeneration': 'allow_adult',
        },
    }
    return _post_and_save(url, body, output, fmt='imagen')


def _post_and_save(url, body, output, fmt):
    token = get_token()
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        print(f'HTTP {e.code}: {err_body[:500]}', file=sys.stderr)
        sys.exit(1)

    img_b64 = None
    if fmt == 'gemini':
        for c in data.get('candidates', []):
            for p in c.get('content', {}).get('parts', []):
                if 'inlineData' in p and 'data' in p['inlineData']:
                    img_b64 = p['inlineData']['data']
                    break
            if img_b64:
                break
    elif fmt == 'imagen':
        preds = data.get('predictions', [])
        if preds and 'bytesBase64Encoded' in preds[0]:
            img_b64 = preds[0]['bytesBase64Encoded']

    if not img_b64:
        print(f'No image in response: {json.dumps(data)[:500]}', file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    with open(output, 'wb') as f:
        f.write(base64.b64decode(img_b64))
    size = os.path.getsize(output)
    print(f'OK {output} ({size} bytes)')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('prompt')
    p.add_argument('--output', '-o', required=True)
    p.add_argument('--model', '-m', default='nano-banana',
                   help='nano-banana (default) | imagen-4 | imagen-4-fast | imagen-4-ultra')
    args = p.parse_args()

    if args.model == 'nano-banana':
        gen_nano_banana(args.prompt, args.output)
    elif args.model == 'imagen-4':
        gen_imagen(args.prompt, args.output, 'imagen-4.0-generate-001')
    elif args.model == 'imagen-4-fast':
        gen_imagen(args.prompt, args.output, 'imagen-4.0-fast-generate-001')
    elif args.model == 'imagen-4-ultra':
        gen_imagen(args.prompt, args.output, 'imagen-4.0-ultra-generate-001')
    else:
        print(f'unknown model: {args.model}', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
