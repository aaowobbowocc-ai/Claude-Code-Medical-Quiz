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
        # 中文
        '神經核', '脊髓', '腦幹', '延腦', '橋腦', '小腦', '大腦', '基底核',
        '視丘', '下視丘', '脊神經', '顱神經', '動脈', '靜脈', '淋巴',
        '骨骼', '關節', '肌肉', '韌帶', '肌腱', '筋膜', '腱鞘',
        '椎骨', '肋骨', '胸骨', '鎖骨', '肩胛骨', '骨盆', '股骨',
        '頭骨', '顱骨', '眼眶', '鼻竇', '額竇', '蝶竇', '篩竇',
        '心包膜', '胸膜', '腹膜', '橫膈', '縱膈', '腹股溝',
        '主動脈', '腔靜脈', '門靜脈', '肺動脈', '冠狀動脈',
        '臂神經叢', '腰神經叢', '薦神經叢', '迷走神經', '膈神經',
        '三叉神經', '顏面神經', '動眼神經', '舌咽神經',
        '解剖', '構造', '位置', '走向', '開口', '分支', '支配',
        # 英文
        'nerve', 'artery', 'vein', 'muscle', 'bone', 'ligament', 'tendon',
        'spinal', 'cerebral', 'medullary', 'brainstem', 'cerebellum',
        'nucleus', 'ganglion', 'plexus', 'cortex', 'gyrus', 'sulcus',
        'orbit', 'sinus', 'fossa', 'foramen', 'canal', 'duct',
        'pericardium', 'pleural', 'peritoneum', 'diaphragm', 'mediastinum',
        'aorta', 'vena cava', 'portal', 'coronary',
        'vagus', 'phrenic', 'sympathetic', 'parasympathetic',
        'femur', 'tibia', 'fibula', 'humerus', 'radius', 'ulna',
        'vertebra', 'sacrum', 'pelvis', 'sternum', 'rib', 'clavicle',
        'testis', 'ovary', 'uterus', 'kidney', 'ureter', 'bladder',
        'liver', 'spleen', 'pancreas', 'adrenal', 'thyroid',
        'lymph node', 'thoracic duct',
        'rectal', 'rectum', 'prostate', 'palpation',
        '直腸', '前列腺', '觸診', '攝護腺',
    ]),
    ('physiology',   '生理學',   2, [
        # 中文
        '心跳', '心率', '血壓', '心輸出量', '心搏量', '心臟',
        '靜止電位', '動作電位', '膜電位', '去極化', '再極化',
        '腎小管', '腎絲球', '腎臟過濾', '腎元', '集尿管',
        '肺活量', '換氣', '呼吸', '潮氣量', '殘餘量', '肺泡',
        '胃酸', '消化', '腸胃', '腸道', '蠕動', '吸收',
        '荷爾蒙', '胰島素', '升糖素', '腎上腺素', '皮質醇',
        '體溫調節', '血糖', '血鈣', '血鈉', '血鉀', '滲透壓',
        '滲透', '擴散', '主動運輸', '被動運輸',
        '血紅素', '血比容', '血液凝固', '凝血',
        # 英文
        'cardiac output', 'stroke volume', 'heart rate', 'preload', 'afterload',
        'action potential', 'resting potential', 'depolarization', 'repolarization',
        'glomerular', 'tubular', 'renal clearance', 'filtration', 'reabsorption',
        'tidal volume', 'alveolar', 'ventilation', 'compliance', 'surfactant',
        'blood flow', 'vascular resistance', 'starling', 'poiseuille',
        'osmotic', 'osmolality', 'tonicity', 'hypertonic', 'hypotonic', 'isotonic',
        'diffusion', 'active transport', 'cotransport', 'antiport',
        'hemoglobin', 'hematocrit', 'erythrocyte', 'coagulation',
        'isometric', 'isotonic', 'muscle contraction', 'sarcomere',
        'baroreceptor', 'chemoreceptor', 'proprioceptor',
        'cilia', 'ciliary', 'cilium', 'flagella',
        '纖毛', '鞭毛', '黏液', '黏液清除',
        '貧血', '紅血球', '血紅素合成', '缺鐵',
        'anemia', 'erythropoiesis', 'iron deficiency', 'ferritin',
        '生理', '功能', '調節', '恆定', '平衡',
    ]),
    ('biochemistry', '生物化學', 3, [
        # 中文
        'ATP', 'ADP', 'AMP', 'NAD', 'NADH', 'FAD', 'FADH', 'CoA', 'acetyl',
        '糖解', '檸檬酸循環', '氧化磷酸化', '電子傳遞鏈', '克氏循環',
        '脂肪酸', 'β氧化', '酮體', '膽固醇', '磷脂', '三酸甘油酯',
        '胺基酸', '蛋白質合成', '轉譯', '轉錄', 'DNA複製', 'RNA',
        '酵素', '受質', 'Km', 'Vmax', '抑制劑', '輔酶', '輔因子',
        '嘌呤', '嘧啶', '核苷酸', '核酸', '基因', '突變',
        '維生素', '葉酸', '鈷胺', '硫胺', '核黃素',
        '訊息傳遞', '第二訊息', 'cAMP', 'cGMP',
        # 英文
        'glucose', 'glycolysis', 'pyruvate', 'lactate', 'citric acid cycle',
        'fatty acid', 'ketone', 'cholesterol', 'phospholipid', 'triglyceride',
        'amino acid', 'peptide', 'polypeptide', 'glutathione', 'tryptophan',
        'enzyme', 'substrate', 'inhibitor', 'coenzyme', 'cofactor',
        'protein', 'DNA', 'RNA', 'transcription', 'translation', 'replication',
        'purine', 'pyrimidine', 'nucleotide', 'nucleoside',
        'vitamin', 'folate', 'cobalamin', 'thiamine', 'riboflavin',
        'signal transduction', 'second messenger', 'kinase', 'phosphorylation',
        'operator', 'repressor', 'operon', 'promoter', 'prokaryote', 'eukaryote',
        'wavelength', 'absorbance', 'spectrophotometry',
        'disaccharide', 'monosaccharide', 'polysaccharide', 'glycosidic',
        'lactose', 'sucrose', 'maltose', 'fructose', 'galactose',
        '雙醣', '單醣', '多醣', '醣類', '醣苷鍵',
        '生化', '代謝', '合成', '分解', '氧化', '還原',
    ]),
    ('histology',    '組織胚胎學', 4, [
        # 中文
        '上皮', '結締組織', '肌肉組織', '神經組織', '四大組織',
        '纖維母細胞', '膠原蛋白', '彈性纖維', '網狀纖維',
        '緻密骨', '海綿骨', '軟骨', '透明軟骨', '纖維軟骨',
        '胚胎', '胚層', '外胚層', '中胚層', '內胚層', '胚盤',
        '器官形成', '分化', '受精', '著床', '胎盤', '臍帶',
        '神經管', '體節', '腸道形成', '心臟形成',
        '精母細胞', '卵母細胞', '精子形成', '減數分裂',
        '基底膜', '細胞連接', '緊密連接', '橋粒',
        # 英文
        'epithelium', 'connective tissue', 'collagen', 'fibroblast', 'elastin',
        'cartilage', 'compact bone', 'spongy bone', 'osteoblast', 'osteoclast',
        'embryo', 'fetal', 'ectoderm', 'mesoderm', 'endoderm', 'blastocyst',
        'histology', 'tissue', 'organogenesis', 'differentiation',
        'neural tube', 'somite', 'notochord', 'pharyngeal arch',
        'spermatogenesis', 'oogenesis', 'meiosis', 'mitosis',
        'tight junction', 'desmosome', 'gap junction', 'basement membrane',
        'myoblast', 'myotube', 'sarcomere', 'myosin', 'actin',
        'gubernaculum', 'mesentery', 'midgut', 'hindgut', 'foregut',
        'microtubule', 'microfilament', 'intermediate filament', 'cytoskeleton',
        'centriole', 'centrosome', 'flagellum',
        'apocrine', 'merocrine', 'holocrine', 'eccrine',
        '細胞骨架', '微管', '微絲', '中間絲',
        '頂漿分泌', '全漿分泌', '局漿分泌',
        '組織', '胚胎', '發育', '增生', '凋亡',
    ]),
    ('microbiology', '微生物與免疫', 5, [
        # 中文
        '抗體', 'IgG', 'IgM', 'IgA', 'IgE', 'IgD',
        'T細胞', 'B細胞', 'NK細胞', '巨噬細胞', '樹突細胞', '嗜中性球',
        'MHC', 'HLA', '補體', '細胞激素', '介白素', '干擾素', '腫瘤壞死因子',
        '病毒', '細菌', '真菌', '格蘭氏染色', '黴漿菌', '披衣菌',
        '噬菌體', '革蘭', '結核菌', '沙門氏菌', '大腸桿菌',
        '愛滋病', 'B型肝炎', 'C型肝炎', '流感', '麻疹',
        '先天免疫', '後天免疫', '體液免疫', '細胞免疫',
        '吞噬', '自體免疫', '過敏', '移植排斥',
        # 英文
        'antibody', 'immunoglobulin', 'T cell', 'B cell', 'cytokine', 'interleukin',
        'complement', 'MHC', 'HLA', 'HIV', 'influenza', 'hepatitis',
        'bacteria', 'virus', 'fungus', 'gram', 'staphylococcus', 'streptococcus',
        'mycobacterium', 'tuberculosis', 'salmonella', 'escherichia',
        'vibrio', 'chlamydia', 'mycoplasma', 'rickettsia', 'spirochete',
        'dermatophyte', 'tinea', 'candida', 'aspergillus',
        'innate immunity', 'adaptive immunity', 'humoral', 'cell-mediated',
        'phagocytosis', 'autoimmune', 'hypersensitivity', 'allergy',
        'vaccine', 'antigen', 'epitope', 'opsonization',
        '弧菌', '披衣菌', '黴漿菌', '立克次體', '螺旋體',
        '皮癬菌', '念珠菌', '黴菌感染', '真菌感染',
        '免疫', '微生物', '感染', '抗原', '病原',
    ]),
    ('parasitology', '寄生蟲學',  6, [
        '寄生蟲', '瘧疾', '疥癬', '蛔蟲', '鉤蟲', '蟯蟲',
        '血吸蟲', '肝吸蟲', '絛蟲', '弓形蟲', '利什曼',
        '瘧原蟲', '阿米巴', '梨形鞭毛蟲', '隱孢子蟲',
        'parasite', 'malaria', 'plasmodium', 'helminth', 'protozoa',
        'ascaris', 'hookworm', 'schistosoma', 'toxoplasma', 'leishmania',
        'giardia', 'cryptosporidium', 'entamoeba',
        '寄生', '蟲卵', '中間宿主', '終宿主', '感染途徑',
    ]),
    ('pharmacology', '藥理學',   7, [
        # 中文
        '藥物', '受體', '拮抗劑', '促進劑', '劑量', '用藥',
        '半衰期', '生體可用率', '藥動學', '藥效學', '清除率',
        '抗生素', '青黴素', '頭孢菌素', '磺胺', '抗癌藥', '化療',
        '降壓藥', '利尿劑', '強心劑', '抗凝血', '抗血小板',
        '鎮痛藥', '麻醉藥', '抗焦慮', '抗憂鬱', '抗精神病',
        '類固醇', '非類固醇消炎藥', 'NSAID', '阿斯匹靈',
        '毛地黃', '奎尼丁', '普魯卡因',
        # 英文
        'receptor', 'agonist', 'antagonist', 'half-life', 'clearance',
        'bioavailability', 'pharmacokinetics', 'pharmacodynamics',
        'antibiotic', 'penicillin', 'cephalosporin', 'aminoglycoside',
        'beta-blocker', 'ACE inhibitor', 'calcium channel blocker', 'statin',
        'diuretic', 'anticoagulant', 'antiplatelet', 'thrombolytic',
        'opioid', 'analgesic', 'anesthetic', 'benzodiazepine',
        'steroid', 'corticosteroid', 'NSAID', 'aspirin', 'ibuprofen',
        'digoxin', 'quinidine', 'lidocaine', 'atropine', 'epinephrine',
        '藥', '治療', '副作用', '毒性', '劑型', '用量',
    ]),
    ('pathology',    '病理學',   8, [
        # 中文
        '壞死', '梗塞', '栓塞', '血栓', '出血', '缺血',
        '發炎', '急性發炎', '慢性發炎', '肉芽腫', '膿瘍', '蜂窩組織炎',
        '腫瘤', '癌', '肉瘤', '轉移', '惡性', '良性', '分化',
        '纖維化', '肝硬化', '腎病症候群', '腎炎',
        '動脈硬化', '粥狀硬化', '高血壓性', '心肌梗塞',
        '肺癌', '胃癌', '大腸癌', '乳癌', '肝癌', '淋巴瘤',
        '萎縮', '肥大', '增生', '化生', '發育不良',
        '水腫', '充血', '瘀血',
        # 英文
        'necrosis', 'infarction', 'thrombosis', 'embolism', 'ischemia',
        'inflammation', 'granuloma', 'abscess', 'edema', 'congestion',
        'carcinoma', 'sarcoma', 'metastasis', 'lymphoma', 'leukemia',
        'fibrosis', 'cirrhosis', 'atrophy', 'hypertrophy', 'hyperplasia',
        'dysplasia', 'metaplasia', 'neoplasm', 'benign', 'malignant',
        'atherosclerosis', 'arteriosclerosis', 'myocardial infarction',
        '病理', '病變', '損傷', '退化', '壞死', '凋亡',
    ]),
    ('public_health','公共衛生',  9, [
        # 中文
        '流行病', '盛行率', '發生率', '相對危險性', '勝算比', '風險',
        '篩檢', '敏感度', '特異度', '陽性預測值', '陰性預測值',
        '隨機對照試驗', '世代研究', '病例對照', '橫斷研究',
        '疫苗', '群體免疫', '接種率', '預防接種',
        '統計', '信賴區間', 'p值', '檢定力', '標準差', '變異數',
        '職業病', '環境衛生', '食品安全', '母嬰', '老人',
        '死亡率', '致死率', '存活率', '平均餘命',
        # 英文
        'epidemiology', 'incidence', 'prevalence', 'relative risk',
        'odds ratio', 'sensitivity', 'specificity', 'predictive value',
        'randomized controlled trial', 'cohort', 'case-control', 'cross-sectional',
        'vaccine', 'herd immunity', 'confidence interval', 'p-value',
        'standard deviation', 'variance', 'bias', 'confounding',
        'mortality', 'morbidity', 'life expectancy', 'crude rate',
        'regression', 'linear regression', 'logistic regression', 'correlation',
        'PM2.5', 'particulate matter', 'air pollution', 'occupational',
        'ADL', 'activities of daily living', 'quality of life',
        'health system', 'payment', 'insurance', 'reimbursement',
        '迴歸', '線性迴歸', '相關係數', '統計模型',
        '細懸浮微粒', '空氣污染', '懸浮微粒', '環境污染',
        '健康城市', '支付制度', '健保', '醫療保險', '給付',
        '日常生活', '功能評估', '失能', '長照',
        '公衛', '預防', '健康促進', '環境', '衛生',
    ]),
]

# Manual overrides: (roc_year, session, subject, q_start, q_end, tag)
# Use when keyword matching misfires due to overlapping anatomical terms
MANUAL_OVERRIDES = [
    ('110', '第一次', '醫學(一)', 32, 46, 'histology'),  # 組織胚胎學區段被誤判為解剖
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

def fill_by_neighbors(questions_in_exam):
    """
    Within one exam, same-subject questions have consecutive numbers.
    Pass 1: Fill 'unknown' questions using majority neighbor tag.
    Pass 2: Correct isolated misclassifications — if ≥3 neighbors agree on
            a different tag AND ≤1 neighbor supports the current tag, override.
    Repeats up to 6 passes until convergence.
    """
    tag_meta = {tag: (name, stage) for tag, name, stage, _ in SUBJECT_RULES}
    qs = sorted(questions_in_exam, key=lambda q: q['number'])

    for _ in range(6):
        changed = False
        for i, q in enumerate(qs):
            window = qs[max(0, i-4):i] + qs[i+1:min(len(qs), i+5)]
            neighbor_tags = [n['subject_tag'] for n in window if n['subject_tag'] != 'unknown']
            if not neighbor_tags:
                continue
            best = max(set(neighbor_tags), key=neighbor_tags.count)
            best_count = neighbor_tags.count(best)
            cur_count  = neighbor_tags.count(q['subject_tag'])

            # Fill unknown
            if q['subject_tag'] == 'unknown' and best != 'unknown':
                q['subject_tag'] = best
                q['subject_name'], q['stage_id'] = tag_meta.get(best, ('未分類', 0))
                changed = True
            # Correct isolated misclassification:
            # ≥3 neighbors agree on different tag, ≤1 neighbor supports current
            elif q['subject_tag'] != best and best_count >= 3 and cur_count <= 1:
                q['subject_tag'] = best
                q['subject_name'], q['stage_id'] = tag_meta.get(best, ('未分類', 0))
                changed = True

        if not changed:
            break

def main():
    with open(INPUT, encoding='utf-8') as f:
        data = json.load(f)

    all_questions = []
    tag_counts = {}

    for exam in data['exams']:
        exam_qs = []
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
                **({'image_url': q['image_url']} if q.get('image_url') else {}),
            }
            exam_qs.append(q_out)

        # Apply manual overrides
        tag_meta = {tag: (name, stage) for tag, name, stage, _ in SUBJECT_RULES}
        for rule in MANUAL_OVERRIDES:
            yr, sess, subj, qstart, qend, force_tag = rule
            if exam['roc_year'] == yr and exam['session'] == sess and exam['subject'] == subj:
                for q_out in exam_qs:
                    if qstart <= q_out['number'] <= qend:
                        q_out['subject_tag'] = force_tag
                        q_out['subject_name'], q_out['stage_id'] = tag_meta[force_tag]

        # Fill unknowns using neighboring question numbers (same subject = consecutive)
        fill_by_neighbors(exam_qs)
        all_questions.extend(exam_qs)

    for q in all_questions:
        tag_counts[q['subject_tag']] = tag_counts.get(q['subject_tag'], 0) + 1

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
