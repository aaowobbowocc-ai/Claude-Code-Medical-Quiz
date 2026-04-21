#!/usr/bin/env python
# OCR a single image and write JSON output. Isolated subprocess to avoid memory accumulation.
# Args: <image_path> <output_json_path>
import sys, json, os, io
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
os.environ.setdefault('FLAGS_use_mkldnn', '0')
os.environ.setdefault('FLAGS_enable_pir_in_executor', '0')

def main():
    img, out = sys.argv[1], sys.argv[2]
    from paddleocr import PaddleOCR
    kwargs = dict(use_textline_orientation=False, enable_mkldnn=False)
    try:
        ocr = PaddleOCR(lang='chinese_cht', **kwargs)
    except Exception:
        ocr = PaddleOCR(lang='ch', **kwargs)

    items = []
    # paddleocr 3.x
    try:
        result = ocr.predict(img)
        for page in result:
            texts = page.get('rec_texts', []) or []
            polys = page.get('rec_polys', []) or page.get('dt_polys', [])
            scores = page.get('rec_scores', []) or [1.0] * len(texts)
            for t, poly, sc in zip(texts, polys, scores):
                xs = [float(p[0]) for p in poly]; ys = [float(p[1]) for p in poly]
                items.append({
                    'text': t, 'conf': float(sc),
                    'xmin': min(xs), 'xmax': max(xs),
                    'ymin': min(ys), 'ymax': max(ys),
                    'cx': sum(xs)/len(xs), 'cy': sum(ys)/len(ys),
                })
    except Exception as e:
        # fallback 2.x
        result = ocr.ocr(img, cls=True)
        if result and result[0]:
            for line in result[0]:
                poly, (text, conf) = line
                xs = [float(p[0]) for p in poly]; ys = [float(p[1]) for p in poly]
                items.append({
                    'text': text, 'conf': float(conf),
                    'xmin': min(xs), 'xmax': max(xs),
                    'ymin': min(ys), 'ymax': max(ys),
                    'cx': sum(xs)/len(xs), 'cy': sum(ys)/len(ys),
                })
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False)
    print(f'OK {len(items)} boxes -> {out}', flush=True)

if __name__ == '__main__':
    main()
