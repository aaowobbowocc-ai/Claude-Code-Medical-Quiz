#!/usr/bin/env python3
"""
classify_all.py — 將 doctor2/dental1/dental2/pharma1/pharma2 題庫依子科目分類
使用固定模板：同科題目連續、每年各小科題數相同
模板由 DP + 關鍵字分析 + 考選部命題大綱交叉驗證而得
"""
import json, sys, os
sys.stdout.reconfigure(encoding='utf-8')

BASE = r'C:\Users\USER\Desktop\國考知識\醫師知識王\backend'

# ============================================================
# Subject definitions (tag, display_name, stage_id)
# ============================================================
SUBJECTS = {
    # Doctor2
    'internal_medicine':       ('內科', 1),
    'psychiatry':              ('精神科', 4),
    'dermatology':             ('皮膚科', 5),
    'pediatrics':              ('小兒科', 6),
    'neurology':               ('神經科', 7),
    'surgery':                 ('外科', 8),
    'orthopedics':             ('骨科', 9),
    'urology':                 ('泌尿科', 10),
    'anesthesia':              ('麻醉科', 11),
    'ophthalmology':           ('眼科', 12),
    'ent':                     ('耳鼻喉科', 13),
    'obstetrics_gynecology':   ('婦產科', 14),
    'rehabilitation':          ('復健科', 15),
    'medical_law_ethics':      ('醫學倫理與法規', 17),
    # Dental1
    'dental_anatomy':          ('牙醫解剖', 1),
    'tooth_morphology':        ('牙體形態', 3),
    'embryology_histology':    ('胚胎組織', 4),
    'oral_pathology':          ('口腔病理', 5),
    'oral_physiology':         ('口腔生理', 8),
    'dental_microbiology':     ('微免', 7),
    'dental_pharmacology':     ('牙科藥理', 6),
    # Dental2
    'endodontics':             ('牙髓病', 5),
    'operative_dentistry':     ('牙體復形', 7),
    'periodontics':            ('牙周病學', 2),
    'oral_surgery':            ('口腔顎面外科', 1),
    'dental_radiology':        ('口腔影像', 12),
    'removable_prosthodontics':('活動補綴', 10),
    'dental_materials':        ('牙科材料', 8),
    'fixed_prosthodontics':    ('固定補綴', 9),
    'orthodontics':            ('齒顎矯正', 3),
    'pediatric_dentistry':     ('兒童牙科', 4),
    'dental_public_health':    ('公衛', 13),
    'dental_ethics_law':       ('倫理法規', 14),
    # Pharma1
    'pharmacology':            ('藥理學', 1),
    'medicinal_chemistry':     ('藥物化學', 2),
    'pharmaceutical_analysis': ('藥物分析', 3),
    'pharmacognosy':           ('生藥學', 4),
    'pharmaceutics':           ('藥劑學', 5),
    'biopharmaceutics':        ('生物藥劑學', 6),
    # Pharma2
    'dispensing':              ('調劑學', 1),
    'clinical_pharmacy':       ('臨床藥學', 2),
    'pharmacotherapy':         ('藥物治療學', 3),
    'pharmacy_law':            ('藥事行政法規', 4),
    # Doctor1
    'anatomy':                 ('解剖學', 1),
    'embryology':              ('胚胎學', 2),
    'histology':               ('組織學', 3),
    'physiology':              ('生理學', 4),
    'biochemistry':            ('生物化學', 5),
    'microbiology':            ('微生物與免疫', 6),
    'parasitology':            ('寄生蟲學', 7),
    'public_health':           ('公共衛生', 8),
    'd1_pharmacology':         ('藥理學', 9),
    'pathology':               ('病理學', 10),
}

# ============================================================
# Fixed contiguous-block templates
# Each template: list of (tag, count)
# Questions Q1..Qcount1 = tag1, Qcount1+1..Qcount1+count2 = tag2, etc.
# Templates verified via DP keyword analysis on 110-113 data + PDF headers
# ============================================================

# --- Doctor1 ---
# 醫學(一): 生物化學、解剖學、胚胎及發育生物學、組織學、生理學 (100題)
# DP shared boundary: 31|5|10|27|27
DOCTOR1_PAPER1 = [('anatomy', 31), ('embryology', 5), ('histology', 10),
                  ('physiology', 27), ('biochemistry', 27)]

# 醫學(二): 微生物免疫學、寄生蟲學、藥理學、病理學、公共衛生學 (100題)
# DP shared boundary: 28|7|15|25|25
DOCTOR1_PAPER2 = [('microbiology', 28), ('parasitology', 7), ('public_health', 15),
                  ('d1_pharmacology', 25), ('pathology', 25)]

DOCTOR1_TEMPLATES = {
    '醫學(一)': DOCTOR1_PAPER1,
    '醫學(二)': DOCTOR1_PAPER2,
}

# --- Doctor2 ---
# 醫學(三): PDF says "內科、家庭醫學科等科目"
# All 80 questions are 內科 (including subspecialties: 傳染, 血液, 家醫)
DOCTOR2_PAPER3 = [('internal_medicine', 80)]

# 醫學(四): PDF says "小兒科、皮膚科、神經科、精神科等科目"
# DP shared boundary: 33|10|15|22
DOCTOR2_PAPER4 = [('pediatrics', 33), ('dermatology', 10), ('neurology', 15), ('psychiatry', 22)]

# 醫學(五): PDF says "外科、骨科、泌尿科等科目" (110-113 only)
# DP shared boundary: 55|8|17
DOCTOR2_PAPER5 = [('surgery', 55), ('orthopedics', 8), ('urology', 17)]

# 醫學(六): PDF says "麻醉科、眼科、耳鼻喉科、婦產科、復健科等科目" (110-113 only)
# DP shared boundary: 8|10|9|30|18|5 (last 5 = 倫理)
DOCTOR2_PAPER6 = [('anesthesia', 8), ('ophthalmology', 10), ('ent', 9),
                  ('obstetrics_gynecology', 30), ('rehabilitation', 18),
                  ('medical_law_ethics', 5)]

# All years use the same template per paper (no restructuring)
DOCTOR2_TEMPLATES = {
    '醫學(三)': DOCTOR2_PAPER3,
    '醫學(四)': DOCTOR2_PAPER4,
    '醫學(五)': DOCTOR2_PAPER5,
    '醫學(六)': DOCTOR2_PAPER6,
}

# Paper → backend "subject" field mapping
DOCTOR2_PAPER_TO_SUBJECT = {
    '醫學(三)': '醫學(三)', '醫學(四)': '醫學(四)',
    '醫學(五)': '醫學(五)', '醫學(六)': '醫學(六)',
}

# --- Dental1 ---
# 卷一 (牙醫學一): 口腔解剖、牙體形態、口腔組織胚胎、生物化學
# DP: 22|22|36
DENTAL1_PAPER1 = [('dental_anatomy', 22), ('tooth_morphology', 22), ('embryology_histology', 36)]

# 卷二 (牙醫學二): 口腔病理、牙科材料、口腔微生物、牙科藥理
# DP: 30|21|13|16
DENTAL1_PAPER2 = [('oral_pathology', 30), ('oral_physiology', 21),
                  ('dental_microbiology', 13), ('dental_pharmacology', 16)]

DENTAL1_TEMPLATES = {
    '卷一': DENTAL1_PAPER1,
    '卷二': DENTAL1_PAPER2,
}

# --- Dental2 ---
# 卷一 (牙醫學三): 齒內治療(牙髓)、牙體復形、牙周病
# DP: 28|24|28
DENTAL2_PAPER1 = [('endodontics', 28), ('operative_dentistry', 24), ('periodontics', 28)]

# 卷二 (牙醫學四): 口腔顎面外科、牙科放射線
# DP: 55|25 (口腔診斷 merged into 口外)
DENTAL2_PAPER2 = [('oral_surgery', 55), ('dental_radiology', 25)]

# 卷三 (牙醫學五): 全口贗復(活動)、牙冠牙橋(固定)、牙材、咬合
# DP: 43|23|14
DENTAL2_PAPER3 = [('removable_prosthodontics', 43), ('dental_materials', 23),
                  ('fixed_prosthodontics', 14)]

# 卷四 (牙醫學六): 齒顎矯正、兒童牙科、公衛、倫理
# DP: 28|32|16|4
DENTAL2_PAPER4 = [('orthodontics', 28), ('pediatric_dentistry', 32),
                  ('dental_public_health', 16), ('dental_ethics_law', 4)]

DENTAL2_TEMPLATES = {
    '卷一': DENTAL2_PAPER1,
    '卷二': DENTAL2_PAPER2,
    '卷三': DENTAL2_PAPER3,
    '卷四': DENTAL2_PAPER4,
}

# --- Pharma1 ---
# Fixed number splits per paper (verified 100% consistent across 10 sessions)
PHARMA1_TEMPLATES = {
    '卷一': [('pharmacology', 40), ('medicinal_chemistry', 40)],
    '卷二': [('pharmaceutical_analysis', 40), ('pharmacognosy', 40)],
    '卷三': [('pharmaceutics', 40), ('biopharmaceutics', 40)],
}

# --- Pharma2 ---
# Fixed: 法規50, 藥物治療80, 調劑與臨床80 (order in JSON: 法規→治療→調劑)
PHARMA2_TEMPLATES = {
    '法規':      [('pharmacy_law', 50)],
    '藥物治療':  [('pharmacotherapy', 80)],
    '調劑與臨床': [('dispensing', 27), ('clinical_pharmacy', 27), ('pharmacotherapy', 26)],
}


# ============================================================
# Apply templates to questions
# ============================================================
def apply_template(questions, template):
    """Apply a contiguous-block template to a list of questions sorted by number.
    template: [(tag, count), ...]
    """
    idx = 0
    for tag, count in template:
        name, stage = SUBJECTS[tag]
        for i in range(idx, min(idx + count, len(questions))):
            questions[i]['subject_tag'] = tag
            questions[i]['subject_name'] = name
            questions[i]['stage_id'] = stage
        idx += count


def get_doctor2_template(paper, roc_year):
    """Get the template for a doctor2 paper."""
    return DOCTOR2_TEMPLATES.get(paper)


def process_exam(exam_name, json_path, get_template_fn):
    """Process one exam type using fixed templates."""
    with open(json_path, encoding='utf-8') as f:
        data = json.load(f)

    questions = data['questions']

    # Clear old classification
    for q in questions:
        q['subject_tag'] = 'unknown'
        q['subject_name'] = '未分類'
        q['stage_id'] = 0

    # Group by (year, session, paper/subject)
    groups = {}
    for q in questions:
        key = (q['roc_year'], q['session'], q['subject'])
        groups.setdefault(key, []).append(q)

    classified = 0
    for (year, session, paper), group in groups.items():
        group.sort(key=lambda x: x['number'])
        template = get_template_fn(paper, year)
        if template:
            apply_template(group, template)
            classified += len(group)
        else:
            # Fallback: mark as unknown
            for q in group:
                q['subject_tag'] = 'unknown'
                q['subject_name'] = '未分類'
                q['stage_id'] = 0

    # Collect all tags used
    tag_counts = {}
    for q in questions:
        tag = q.get('subject_tag', 'unknown')
        tag_counts[tag] = tag_counts.get(tag, 0) + 1

    # Build stages
    seen_tags = set()
    stages = []
    for q in questions:
        tag = q.get('subject_tag', 'unknown')
        if tag not in seen_tags:
            seen_tags.add(tag)
            name, stage = SUBJECTS.get(tag, ('未分類', 0))
            stages.append({'id': stage, 'tag': tag, 'name': name, 'count': tag_counts.get(tag, 0)})

    data['stages'] = stages
    data['questions'] = questions

    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return tag_counts, classified


def main():
    # ── Doctor1 ──
    print('=' * 50)
    print(' doctor1')
    print('=' * 50)
    path = os.path.join(BASE, 'questions.json')
    counts, n = process_exam('doctor1', path, lambda paper, year: DOCTOR1_TEMPLATES.get(paper))
    print_counts(counts, n)

    # ── Doctor2 ──
    print('\n' + '=' * 50)
    print(' doctor2')
    print('=' * 50)
    path = os.path.join(BASE, 'questions-doctor2.json')
    counts, n = process_exam('doctor2', path, get_doctor2_template)
    print_counts(counts, n)

    # ── Dental1 ──
    print('\n' + '=' * 50)
    print(' dental1')
    print('=' * 50)
    path = os.path.join(BASE, 'questions-dental1.json')
    counts, n = process_exam('dental1', path, lambda paper, year: DENTAL1_TEMPLATES.get(paper))
    print_counts(counts, n)

    # ── Dental2 ──
    print('\n' + '=' * 50)
    print(' dental2')
    print('=' * 50)
    path = os.path.join(BASE, 'questions-dental2.json')
    counts, n = process_exam('dental2', path, lambda paper, year: DENTAL2_TEMPLATES.get(paper))
    print_counts(counts, n)

    # ── Pharma1 ──
    print('\n' + '=' * 50)
    print(' pharma1')
    print('=' * 50)
    path = os.path.join(BASE, 'questions-pharma1.json')
    counts, n = process_exam('pharma1', path, lambda paper, year: PHARMA1_TEMPLATES.get(paper))
    print_counts(counts, n)

    # ── Pharma2 ──
    print('\n' + '=' * 50)
    print(' pharma2')
    print('=' * 50)
    path = os.path.join(BASE, 'questions-pharma2.json')
    counts, n = process_exam('pharma2', path, lambda paper, year: PHARMA2_TEMPLATES.get(paper))
    print_counts(counts, n)


def print_counts(counts, classified):
    total = sum(counts.values())
    unknown = counts.get('unknown', 0)
    print(f'  Total: {total}, Classified: {classified}, Unknown: {unknown}')
    for tag, cnt in sorted(counts.items(), key=lambda x: -x[1]):
        name = SUBJECTS.get(tag, ('?', 0))[0]
        print(f'    {name:16s}: {cnt:4d} ({cnt*100/total:.1f}%)')


if __name__ == '__main__':
    main()
