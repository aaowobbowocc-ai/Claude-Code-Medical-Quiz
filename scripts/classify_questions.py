#!/usr/bin/env python3
"""
classify_questions.py
依科目關鍵字將題庫中每題標上 subject_tag（細分科目）
輸出: backend/questions.json
"""
import json, re, sys, os
sys.stdout.reconfigure(encoding='utf-8')

INPUT  = r'C:\Users\USER\Desktop\國考知識\題庫\醫師國考一階題庫.json'
OUTPUT = r'C:\Users\USER\Desktop\國考知識\醫師知識王\backend\questions.json'

# subject_tag → (display_name, stage_id, keywords)
SUBJECT_RULES = [
    ('anatomy',      '解剖學',   1, [
        '神經核', '脊髓', '腦幹', '延腦', '橋腦', '小腦', '大腦', '基底核',
        '視丘', '下視丘', '脊神經', '顱神經', '動脈', '靜脈', '淋巴',
        '骨骼', '關節', '肌肉', '韌帶', '肌腱',
        'nerve', 'artery', 'vein', 'muscle', 'bone', 'ligament',
        'spinal', 'cerebral', 'medullary', 'brainstem', 'cerebellum',
        'nucleus', 'ganglion', 'plexus', 'cortex', 'gyrus', 'sulcus',
        '解剖', '構造', '位置', '走向',
    ]),
    ('physiology',   '生理學',   2, [
        '心跳', '血壓', '心輸出量', '靜止電位', '動作電位', '膜電位',
        '腎小管', '腎絲球', '腎臟過濾', '肺活量', '換氣', '呼吸',
        '胃酸', '消化', '腸胃', '荷爾蒙', '胰島素', '升糖素',
        'cardiac output', 'action potential', 'resting potential',
        'glomerular', 'tubular', 'renal clearance',
        'tidal volume', 'alveolar', 'ventilation',
        'blood flow', 'vascular resistance', 'starling',
        '生理', '功能', '調節', '恆定',
    ]),
    ('biochemistry', '生物化學', 3, [
        'ATP', 'ADP', 'NAD', 'FAD', 'CoA', 'acetyl',
        '糖解', '檸檬酸循環', '氧化磷酸化', '電子傳遞鏈',
        '脂肪酸', 'β氧化', '酮體', '膽固醇', '磷脂',
        '胺基酸', '蛋白質合成', '轉譯', '轉錄', 'DNA複製',
        '酵素', '受質', 'Km', 'Vmax', '抑制劑',
        'glucose', 'glycolysis', 'pyruvate', 'citric acid cycle',
        'fatty acid', 'amino acid', 'enzyme', 'substrate',
        'protein', 'DNA', 'RNA', 'transcription', 'translation',
        '生化', '代謝', '合成', '分解',
    ]),
    ('histology',    '組織胚胎學', 4, [
        '上皮', '結締組織', '肌肉組織', '神經組織',
        '纖維母細胞', '膠原蛋白', '彈性纖維',
        '緻密骨', '海綿骨', '軟骨',
        '胚胎', '胚層', '外胚層', '中胚層', '內胚層',
        '器官形成', '分化', '受精', '著床',
        'epithelium', 'connective tissue', 'collagen', 'fibroblast',
        'embryo', 'fetal', 'ectoderm', 'mesoderm', 'endoderm',
        'histology', 'tissue', 'organogenesis',
        '組織', '胚胎', '發育',
    ]),
    ('microbiology', '微生物與免疫', 5, [
        '抗體', 'IgG', 'IgM', 'IgA', 'IgE', 'IgD',
        'T細胞', 'B細胞', 'NK細胞', '巨噬細胞', '樹突細胞',
        'MHC', 'HLA', '補體', '細胞激素', '介白素',
        '病毒', '細菌', '真菌', '格蘭氏染色',
        '病毒複製', '噬菌體', '革蘭', '結核菌',
        'antibody', 'T cell', 'B cell', 'cytokine', 'interleukin',
        'complement', 'MHC', 'HIV', 'influenza', 'hepatitis',
        'bacteria', 'virus', 'gram', 'staphylococcus', 'streptococcus',
        '免疫', '微生物', '感染', '抗原',
    ]),
    ('parasitology', '寄生蟲學',  6, [
        '寄生蟲', '瘧疾', '疥癬', '蛔蟲', '鉤蟲', '蟯蟲',
        '血吸蟲', '肝吸蟲', '絛蟲', '弓形蟲',
        '瘧原蟲', '阿米巴', '梨形鞭毛蟲',
        'parasite', 'malaria', 'plasmodium', 'helminth', 'protozoa',
        'ascaris', 'hookworm', 'schistosoma', 'toxoplasma',
        '寄生', '蟲卵', '中間宿主', '終宿主',
    ]),
    ('pharmacology', '藥理學',   7, [
        '藥物', '受體', '拮抗劑', '促進劑', '劑量',
        '半衰期', '生體可用率', '藥動學', '藥效學',
        '抗生素', '青黴素', '磺胺', '抗癌藥', '化療',
        '降壓藥', '利尿劑', '強心劑', '抗凝血',
        'receptor', 'agonist', 'antagonist', 'half-life',
        'bioavailability', 'pharmacokinetics', 'pharmacodynamics',
        'antibiotic', 'penicillin', 'beta-blocker', 'ACE inhibitor',
        'diuretic', 'anticoagulant', 'chemotherapy',
        '藥', '治療', '副作用', '毒性',
    ]),
    ('pathology',    '病理學',   8, [
        '壞死', '梗塞', '栓塞', '血栓', '出血',
        '發炎', '肉芽腫', '膿瘍', '蜂窩組織炎',
        '腫瘤', '癌', '肉瘤', '轉移', '分化',
        '纖維化', '肝硬化', '腎病症候群',
        'necrosis', 'infarction', 'thrombosis', 'embolism',
        'inflammation', 'granuloma', 'abscess', 'edema',
        'carcinoma', 'sarcoma', 'metastasis', 'lymphoma',
        'fibrosis', 'cirrhosis', 'atrophy', 'hypertrophy',
        '病理', '病變', '損傷', '退化',
    ]),
    ('public_health','公共衛生',  9, [
        '流行病', '盛行率', '發生率', '相對危險性', '勝算比',
        '篩檢', '敏感度', '特異度', '預測值',
        '隨機對照試驗', '世代研究', '病例對照',
        '疫苗', '群體免疫', '接種率',
        '統計', '信賴區間', 'p值', '檢定力',
        'epidemiology', 'incidence', 'prevalence', 'relative risk',
        'odds ratio', 'sensitivity', 'specificity',
        'randomized controlled trial', 'cohort', 'case-control',
        'vaccine', 'herd immunity', 'confidence interval',
        '公衛', '預防', '健康促進', '環境',
    ]),
]

def classify(q_text):
    text = q_text.lower()
    scores = {}
    for tag, name, stage, keywords in SUBJECT_RULES:
        score = sum(1 for kw in keywords if kw.lower() in text)
        if score > 0:
            scores[tag] = score
    if not scores:
        return 'unknown', '未分類', 0
    best = max(scores, key=scores.get)
    for tag, name, stage, _ in SUBJECT_RULES:
        if tag == best:
            return tag, name, stage
    return 'unknown', '未分類', 0

def main():
    with open(INPUT, encoding='utf-8') as f:
        data = json.load(f)

    all_questions = []
    tag_counts = {}

    for exam in data['exams']:
        for q in exam['questions']:
            full_text = q['question'] + ' ' + ' '.join(q['options'].values())
            tag, name, stage = classify(full_text)

            q_out = {
                'id': f"{exam['exam_code']}_{q['number']}",
                'roc_year': exam['roc_year'],
                'session': exam['session'],
                'exam_code': exam['exam_code'],
                'subject': exam['subject'],
                'subject_tag': tag,
                'subject_name': name,
                'stage_id': stage,
                'number': q['number'],
                'question': q['question'],
                'options': q['options'],
                'answer': q.get('answer'),
            }
            all_questions.append(q_out)
            tag_counts[tag] = tag_counts.get(tag, 0) + 1

    output = {
        'metadata': data['metadata'],
        'total': len(all_questions),
        'questions': all_questions,
        'stages': [
            {'id': stage, 'tag': tag, 'name': name, 'count': tag_counts.get(tag, 0)}
            for tag, name, stage, _ in SUBJECT_RULES
        ] + [{'id': 0, 'tag': 'unknown', 'name': '未分類', 'count': tag_counts.get('unknown', 0)}],
    }

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f'分類完成，共 {len(all_questions)} 題')
    print()
    for tag, name, stage, _ in SUBJECT_RULES:
        print(f'  Stage {stage} {name:10s}: {tag_counts.get(tag, 0):4d} 題')
    print(f'  未分類           : {tag_counts.get("unknown", 0):4d} 題')
    print(f'\n輸出: {OUTPUT}')

if __name__ == '__main__':
    main()
