import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import CommentSection from '../components/CommentSection'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

function getUserId() {
  let id = localStorage.getItem('comment-uid')
  if (!id) {
    id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    localStorage.setItem('comment-uid', id)
  }
  return id
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '剛剛'
  if (mins < 60) return `${mins}分鐘前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}小時前`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}天前`
  return new Date(dateStr).toLocaleDateString('zh-TW')
}

// ── Notes data by exam type ─────────────────────────────────────
const NOTES = {
  doctor1: [
    {
      id: 'anatomy', icon: '🦴', name: '解剖學', color: '#3B82F6',
      cards: [
        { title: '臂神經叢 Brachial Plexus', content: 'Roots → Trunks → Divisions → Cords → Branches\n口訣：「Robert Taylor Drinks Cold Beer」\nC5-T1，上幹(C5-6)、中幹(C7)、下幹(C8-T1)\n常考：Erb-Duchenne palsy (C5-6上幹)、Klumpke palsy (C8-T1下幹)' },
        { title: '顱神經 Cranial Nerves', content: 'I 嗅 II 視 III 動眼 IV 滑車 V 三叉 VI 外旋\nVII 顏面 VIII 聽 IX 舌咽 X 迷走 XI 副 XII 舌下\n口訣：「Oh Oh Oh To Touch And Feel Very Good Velvet AH」\n副交感：III(瞳孔縮)、VII(淚腺唾液)、IX(腮腺)、X(胸腹臟器)' },
        { title: '心臟血管解剖', content: '冠狀動脈：\n右冠 RCA → 後降支(PDA) 供應下壁、AV node(90%)\n左主幹 LM → LAD(前壁、心尖、前室間隔) + LCx(側壁)\n最常阻塞：LAD（widow maker）\n靜脈回流：冠狀竇 → 右心房' },
        { title: '腹膜後器官', content: '口訣：「SAD PUCKER」\nS: Suprarenal glands (腎上腺)\nA: Aorta/IVC (主動脈/下腔靜脈)\nD: Duodenum 2nd-4th parts\nP: Pancreas (胰臟，除尾部)\nU: Ureters (輸尿管)\nC: Colon (升結腸、降結腸)\nK: Kidneys (腎臟)\nE: Esophagus (食道下段)\nR: Rectum (直腸)' },
        { title: '三角區與疝氣', content: 'Hesselbach triangle（直接疝氣）：\n腹直肌外緣、腹壁下動脈、腹股溝韌帶\n間接疝氣：經深環(deep ring)，最常見\nFemoral hernia：股環下方，女性較多，最易嵌頓\n前三角 vs 後三角（頸部）：SCM 為界' },
      ]
    },
    {
      id: 'embryology', icon: '🧫', name: '胚胎學', color: '#F97316',
      cards: [
        { title: '胚層衍生物', content: 'Ectoderm (外胚層):\n皮膚表皮、神經系統、感覺器官、腎上腺髓質、牙齒琺瑯質\n\nMesoderm (中胚層):\n肌肉、骨骼、心血管、腎臟、脾臟、腎上腺皮質、真皮\n\nEndoderm (內胚層):\nGI tract lining、肝臟、胰臟、甲狀腺、副甲狀腺、肺上皮、膀胱\n\nNeural crest (神經脊):\n周邊神經、黑色素細胞、腎上腺髓質、顏面骨、牙齒象牙質' },
        { title: '先天異常', content: 'Neural tube defects:\n葉酸缺乏 → Spina bifida, Anencephaly\n篩檢: ↑AFP(母血/羊水)\n\nDiGeorge: 22q11.2 deletion\n3rd/4th pharyngeal pouch 發育異常\n→ 無胸腺(T cell↓)、無副甲狀腺(Ca²⁺↓)、心臟缺陷\n\nTreacher Collins: 1st pharyngeal arch → 顏面發育不全\nPierre Robin: 小下巴→舌後墜→呼吸道阻塞' },
      ]
    },
    {
      id: 'histology', icon: '🔎', name: '組織學', color: '#6366F1',
      cards: [
        { title: '上皮組織分類', content: '單層鱗狀：肺泡、血管內皮、腹膜\n單層柱狀：腸胃道（含杯狀細胞）\n偽複層纖毛柱狀：呼吸道（鼻腔→支氣管）\n複層鱗狀角化：皮膚\n複層鱗狀非角化：口腔、食道、陰道\n移行上皮(Transitional)：膀胱、輸尿管\n基底膜：Type IV collagen + Laminin' },
        { title: '結締組織', content: 'Collagen types:\nI: 骨、皮膚、肌腱(最多，90%)\nII: 軟骨、玻璃體\nIII: 血管、子宮、肉芽組織(Reticular)\nIV: 基底膜\n疾病：\nEhlers-Danlos: collagen合成缺陷→過度伸展\nMarfan: Fibrillin-1缺陷→主動脈瘤\nOsteogenesis imperfecta: Type I collagen→藍鞏膜、骨折\nScurvy: Vit C缺乏→collagen hydroxylation↓' },
        { title: '腺體分泌方式', content: 'Merocrine (胞吐): 汗腺(eccrine)、唾液腺、胰臟\nApocrine (頂部斷裂): 腋下汗腺、乳腺\nHolocrine (整個細胞崩解): 皮脂腺\n\n外分泌腺結構：\nSerous: 漿液性(腮腺)→酵素\nMucous: 黏液性(舌下腺)→黏液\nMixed: 混合(頜下腺)\nMyoepithelial cells: 圍繞腺泡，幫助擠出分泌物' },
      ]
    },
    {
      id: 'physiology', icon: '⚡', name: '生理學', color: '#8B5CF6',
      cards: [
        { title: '心臟電生理', content: 'SA node → AV node → His bundle → Bundle branches → Purkinje\nSA node 自律性最高(60-100 bpm)\nAV node 傳導最慢(0.05 m/s)→ 允許心房先收縮\nPhase 0: Na⁺快速內流(心肌) / Ca²⁺慢速內流(SA/AV)\nPhase 4: funny current (If) → SA node 自動去極化\nECG: P波(心房) → QRS(心室去極化) → T波(心室再極化)' },
        { title: '腎臟生理', content: 'GFR ~125 mL/min → 180 L/day\nPCT: 65-70% Na⁺/H₂O 再吸收，所有 glucose/AA\nLoop of Henle: 逆流倍增系統，產生髓質滲透梯度\nDCT: PTH→Ca²⁺再吸收；thiazide 作用處\nCD: ADH→aquaporin-2→水再吸收；aldosterone→ENaC→Na⁺再吸收\nRAAS: 腎素→Ang I→(ACE)→Ang II→aldosterone' },
        { title: '呼吸生理', content: 'V/Q ratio 正常 ~0.8\nV/Q=0: shunt (如肺塌陷) → 給 O₂ 無法改善\nV/Q=∞: dead space (如肺栓塞)\n氧合血紅素解離曲線右移(↓親和力)：\n↑CO₂、↑H⁺、↑溫度、↑2,3-DPG\n口訣：「Right shift = Release O₂」\nChemoreceptors: 中樞(CO₂)、周邊(O₂, carotid body)' },
        { title: '酸鹼平衡', content: 'Henderson-Hasselbalch: pH = 6.1 + log([HCO₃⁻]/0.03×PCO₂)\n代謝性酸中毒：計算 AG = Na⁺ - (Cl⁻ + HCO₃⁻)，正常 12±4\nHigh AG: MUDPILES (Methanol, Uremia, DKA, Propylene glycol, INH/Iron, Lactic acid, Ethylene glycol, Salicylates)\nNormal AG: 腹瀉、RTA\n呼吸代償：Winter formula: expected PCO₂ = 1.5×[HCO₃⁻]+8±2' },
        { title: '內分泌軸', content: 'HPA axis: CRH→ACTH→Cortisol (負回饋)\nHPT axis: TRH→TSH→T3/T4\nHPG axis: GnRH(脈衝式)→FSH/LH→E2/Testosterone\nGH: GHRH↑ / Somatostatin↓ → GH → IGF-1(肝)\nProlactin: 唯一被「抑制」控制的(dopamine↓)\nADH: 滲透壓↑ or 血容量↓ → 分泌' },
      ]
    },
    {
      id: 'biochemistry', icon: '🧬', name: '生化學', color: '#10B981',
      cards: [
        { title: '糖解作用 Glycolysis', content: '場所：細胞質\nGlucose → 2 Pyruvate + 2 ATP + 2 NADH\n三個不可逆步驟(關鍵酵素)：\n1. Hexokinase (肝: Glucokinase)\n2. PFK-1 (rate-limiting step!)\n3. Pyruvate kinase\nPFK-1 活化：AMP, F-2,6-BP\nPFK-1 抑制：ATP, citrate\n缺氧時：Pyruvate → Lactate (LDH)' },
        { title: 'TCA cycle + ETC', content: 'TCA (粒線體基質): Acetyl-CoA → 2CO₂ + 3NADH + 1FADH₂ + 1GTP\nETC (內膜): Complex I(NADH)→CoQ→III→Cyt C→IV→O₂\nATP 產量：NADH=2.5 ATP, FADH₂=1.5 ATP\n每個 glucose 淨產 ~30-32 ATP\n抑制劑：Rotenone(I), Antimycin A(III), CN⁻/CO(IV)\n解偶聯劑：2,4-DNP, thermogenin(棕色脂肪)' },
        { title: '脂肪酸代謝', content: 'β-oxidation (粒線體)：\n長鏈脂肪酸需 carnitine shuttle (CPT-I/II)\nCPT-I 被 malonyl-CoA 抑制(進食狀態不做β-ox)\n每回合：切2C → 1 Acetyl-CoA + 1 NADH + 1 FADH₂\nKetone bodies: 肝合成(HMG-CoA synthase)，肝外使用\nDKA: insulin↓ → 大量β-ox → ketoacidosis\n必需脂肪酸：Linoleic (ω-6), Linolenic (ω-3)' },
        { title: '維生素速記', content: 'B1 (Thiamine): Pyruvate DH, α-KG DH → Wernicke-Korsakoff\nB2 (Riboflavin): FAD/FMN\nB3 (Niacin): NAD⁺/NADP⁺ → Pellagra (3D: Diarrhea, Dermatitis, Dementia)\nB6 (Pyridoxine): 轉胺酶輔酶 → INH 副作用\nB9 (Folate): DNA 合成 → 巨母紅血球貧血，懷孕缺乏→NTD\nB12 (Cobalamin): 同上 + 神經症狀\nVit K: Coag factors II, VII, IX, X + Protein C, S' },
        { title: '核酸代謝', content: 'Purine 合成：de novo 從 IMP 開始\n嘌呤回收：HGPRT (缺乏→Lesch-Nyhan: 自殘、痛風、智障)\nPyrimidine 合成：先合成環再接 ribose\n降解：Purine→Xanthine→Uric acid (xanthine oxidase)\n痛風治療：Allopurinol (抑制 xanthine oxidase)\nDNA 修復：NER(thymine dimer), BER(單鹼基), MMR(錯配)' },
      ]
    },
    {
      id: 'microbiology', icon: '🦠', name: '微生物與免疫', color: '#EF4444',
      cards: [
        { title: 'G(+) 球菌', content: 'Staphylococcus aureus:\n- Coagulase(+), catalase(+)\n- TSST-1(toxic shock), Protein A(anti-opsonin)\n- 皮膚感染、心內膜炎、骨髓炎\nStreptococcus pyogenes (GAS):\n- β-hemolysis, Bacitracin sensitive\n- M protein(毒力因子)\n- 咽炎→風溼熱(Jones criteria)、PSGN\nStrep pneumoniae: α-hemolysis, optochin sensitive, 莢膜→肺炎/腦膜炎' },
        { title: 'G(-) 重點', content: 'E. coli: 最常見 UTI、新生兒腦膜炎(K1)\nKlebsiella: 酗酒者肺炎(current jelly sputum)\nPseudomonas: 燒傷感染、CF、綠色色素\n治療: Piperacillin-tazobactam, Ceftazidime, Carbapenem\nNeisseria meningitidis: 腦膜炎雙球菌、瘀斑、Waterhouse-Friderichsen\nH. pylori: 胃潰瘍、MALT lymphoma、urease(+)\n治療: PPI + Clarithromycin + Amoxicillin' },
        { title: '免疫系統', content: 'Innate: Neutrophils(最先到), Macrophages, NK cells, Complement\nAdaptive: T cells(細胞免疫), B cells(體液免疫)\nMHC I: 所有有核細胞 → CD8⁺ T cell\nMHC II: APC(DC, macrophage, B cell) → CD4⁺ T cell\nTh1: IFN-γ → 細胞內病原體\nTh2: IL-4,5,13 → 過敏、寄生蟲\nTh17: IL-17 → 細胞外細菌、黴菌' },
        { title: '過敏反應分型', content: 'Type I: IgE + Mast cell → 即時型(過敏性休克、氣喘)\nType II: IgG/IgM against cell surface → 溶血、Goodpasture\nType III: Immune complex deposit → SLE, 血清病\nType IV: T cell mediated (delayed) → TB skin test、接觸性皮膚炎\n口訣：「ACID」\nA=Anaphylactic, C=Cytotoxic, I=Immune complex, D=Delayed' },
        { title: '病毒重點', content: 'DNA virus: HSV(1:口, 2:生殖器), VZV, EBV, CMV, HPV, HBV\nRNA virus: Influenza(orthomyxo), HIV(retro), HCV, SARS-CoV-2\nHIV: CD4⁺ T cell, reverse transcriptase\n治療: NRTI + NNRTI or PI (HAART)\nHBV 血清學：\nHBsAg(+)=感染, Anti-HBs(+)=免疫\nHBeAg(+)=高傳染力, Anti-HBc IgM=急性\nHPV 16,18: 子宮頸癌；6,11: 尖銳濕疣' },
      ]
    },
    {
      id: 'parasitology', icon: '🪱', name: '寄生蟲學', color: '#14B8A6',
      cards: [
        { title: '瘧疾 Malaria', content: 'Plasmodium 四種(+knowlesi):\nP. falciparum: 最嚴重、腦瘧疾、banana-shaped gametocyte\nP. vivax/ovale: hypnozoite(肝休眠體)→復發，需 primaquine\nP. malariae: 每72hr(quartan)\n傳播：Anopheles 蚊\n診斷：厚/薄血片、快篩\n治療：Chloroquine (非 falciparum)、ACT (falciparum)\nG6PD 需檢查再給 Primaquine' },
        { title: '腸道寄生蟲速記', content: 'Ascaris(蛔蟲): 最大腸道線蟲、Loeffler syndrome(肺)\nEnterobius(蟯蟲): 肛門搔癢、scotch tape test\nAncylostoma/Necator(鉤蟲): 缺鐵性貧血、barefoot\nStrongyloides: autoinfection → 免疫低下者致命\nTrichuris(鞭蟲): barrel-shaped eggs、直腸脫垂\nTaenia: solium(豬)→囊尾蟲症(腦)、saginata(牛)\nEntamoeba histolytica: 痢疾、肝膿瘍(anchovy paste)' },
      ]
    },
    {
      id: 'public_health', icon: '🏥', name: '公共衛生', color: '#84CC16',
      cards: [
        { title: '流行病學研究設計', content: '觀察性：\nCase-control: 回溯、快速、適合罕見疾病 → OR\nCohort: 前瞻/回溯、追蹤暴露組 → RR\nCross-sectional: 某時間點的 prevalence\nEcological: 群體層級(ecological fallacy)\n\n介入性：\nRCT: gold standard、需 blinding + randomization\n\n因果關係: Bradford Hill criteria\n偏差: Selection, Information(recall), Confounding' },
        { title: '生物統計', content: 'Sensitivity: TP/(TP+FN) → 排除疾病(SnNout)\nSpecificity: TN/(TN+FP) → 確認疾病(SpPin)\nPPV: TP/(TP+FP)，受盛行率影響\nNPV: TN/(TN+FN)\n\nType I error (α): 偽陽性(reject true H₀)\nType II error (β): 偽陰性(accept false H₀)\nPower = 1 - β\n\np < 0.05: 統計顯著\nCI 不包含 null value(RR=1, OR=1): 顯著' },
        { title: '預防醫學層級', content: '初段預防 (Primary): 防止疾病發生\n→ 疫苗接種、衛教、安全帶\n\n次段預防 (Secondary): 早期發現早期治療\n→ 篩檢(mammography, Pap smear, colonoscopy)\n\n三段預防 (Tertiary): 減少殘障、復健\n→ 物理治療、支持團體\n\n篩檢條件：疾病嚴重、有潛伏期、\n有可行的檢測方法、早期治療有效' },
      ]
    },
    {
      id: 'd1_pharmacology', icon: '💊', name: '藥理學', color: '#F59E0B',
      cards: [
        { title: '自主神經藥物', content: '交感 α1: 血管收縮 → Phenylephrine(作動), Prazosin(拮抗)\nα2: 突觸前抑制 → Clonidine(中樞降壓)\nβ1: 心臟(↑HR, ↑contractility) → Dobutamine(作動)\nβ2: 支氣管擴張 → Salbutamol(作動)\n副交感 M: Atropine(拮抗), Pilocarpine(作動)\nAChE inhibitor: Neostigmine(可逆), Organophosphate(不可逆→pralidoxime)' },
        { title: '抗生素分類', content: '抑制細胞壁：β-lactams(Penicillin, Ceph, Carbapenem), Vancomycin\n抑制蛋白質合成 30S: Aminoglycosides, Tetracycline\n抑制蛋白質合成 50S: Macrolides, Chloramphenicol, Clindamycin\n口訣：「Buy AT 30, CEL at 50」\n抑制 DNA: Fluoroquinolones(DNA gyrase), Metronidazole\n抑制葉酸: TMP-SMX\nMRSA: Vancomycin, Linezolid, Daptomycin' },
        { title: '心血管藥物', content: 'Anti-HTN 一線：ACEI/ARB, CCB, Thiazide\nACEI: -pril → 乾咳(bradykinin)、高血鉀、禁用孕婦\nARB: -sartan → 比ACEI少咳嗽\nCCB: Amlodipine(血管), Verapamil/Diltiazem(心臟)\nβ-blocker: Metoprolol(β1選擇), Carvedilol(α+β)\nStatins: 抑制 HMG-CoA reductase → ↓LDL，副作用: 橫紋肌溶解\nAnticoagulant: Heparin(APTT), Warfarin(PT/INR)' },
        { title: '止痛與麻醉', content: 'NSAIDs: 抑制 COX → ↓PG\nCOX-1: 保護胃黏膜、血小板 TXA2\nCOX-2: 發炎、疼痛\nAspirin: 不可逆抑制 COX → 低劑量抗血小板\nOpioids: μ receptor → morphine, fentanyl\n副作用: 呼吸抑制、便秘、瞳孔縮小\nNaloxone: μ antagonist → 解毒\nLocal anesthetics: 阻斷 Na⁺ channel → -caine' },
        { title: '抗癲癇藥物', content: 'Partial seizure: Carbamazepine, Phenytoin, Lamotrigine\nGeneralized absence: Ethosuximide (T-type Ca²⁺), Valproic acid\nGeneralized tonic-clonic: Valproic acid, Phenytoin\nStatus epilepticus: IV Benzodiazepine → Phenytoin\nValproic acid: 廣效但→肝毒性、NTD、PCOS\nPhenytoin: Na⁺ channel blocker → 牙齦增生、SJS\nCarbamazepine: 需查 HLA-B*1502(亞洲人→SJS)' },
      ]
    },
    {
      id: 'pathology', icon: '🔬', name: '病理學', color: '#EC4899',
      cards: [
        { title: '細胞損傷與壞死', content: 'Reversible: 細胞腫脹、脂肪變性\nIrreversible: 膜破裂、粒線體功能喪失\n壞死類型：\nCoagulative: 心肌梗塞(最常見)\nLiquefactive: 腦梗塞、膿瘍\nCaseous: 結核(乾酪樣)\nFat: 急性胰臟炎(皂化)\nFibrinoid: 血管炎\nGangrenous: 肢端(乾性)、腸(濕性)\nApoptosis: 程式性死亡、caspase、無發炎' },
        { title: '腫瘤標記', content: 'AFP: 肝細胞癌、卵黃囊瘤\nCEA: 大腸癌(追蹤用)\nCA-125: 卵巢癌\nCA 19-9: 胰臟癌\nPSA: 攝護腺癌\nHCG: 絨毛膜癌、睪丸癌\nS-100: 黑色素瘤、神經腫瘤\nDesmin: 肌肉來源腫瘤\nVimentin: 間質來源(sarcoma)\nCytokeratin: 上皮來源(carcinoma)' },
        { title: '發炎反應', content: '急性發炎：neutrophil 主導\n血管變化：血管擴張→血流增加→紅腫熱\n化學趨化因子：C5a, IL-8, LTB4\n慢性發炎：macrophage + lymphocyte 主導\n肉芽腫(Granuloma)：\nCaseating: TB, fungal\nNon-caseating: Sarcoidosis, Crohn\'s\n發炎介質：\nHistamine→血管通透性↑\nPGE2→發燒、疼痛\nLTC4/D4/E4→支氣管收縮' },
        { title: '血液病理', content: '缺鐵性貧血：MCV↓, ferritin↓, TIBC↑, Fe↓\n巨母紅血球貧血：MCV↑, B12或folate↓\n鐮刀型貧血：HbS, Glu→Val at β-6\n地中海貧血：α(--/--刪除) or β(突變)→Hb電泳\nG6PD 缺乏：X-linked, Heinz bodies, bite cells\n溶血: ↑indirect bilirubin, ↑reticulocyte, ↑LDH, ↓haptoglobin\nDIC: ↑PT/APTT, ↓fibrinogen, ↑D-dimer, schistocytes' },
      ]
    },
  ],

  doctor2: [
    {
      id: 'internal_medicine', icon: '🫀', name: '內科', color: '#EF4444',
      cards: [
        { title: '心衰竭分類與治療', content: 'HFrEF (EF<40%): 收縮功能不全\n四大支柱：ACEI/ARB/ARNI + β-blocker + MRA + SGLT2i\nHFpEF (EF≥50%): 舒張功能不全\n治療：利尿劑控制症狀、SGLT2i\nNYHA 分級：\nI: 無症狀 II: 一般活動有症狀\nIII: 輕微活動有症狀 IV: 休息時有症狀\nBNP/NT-proBNP: 診斷與追蹤指標' },
        { title: '糖尿病診斷與治療', content: '診斷：FPG≥126、OGTT 2hr≥200、HbA1c≥6.5%、隨機血糖≥200+症狀\nT1DM: 自體免疫破壞β cell → insulin 依賴\nT2DM: insulin resistance → 口服藥為主\n一線：Metformin (腎功能注意)\n有心血管疾病：+SGLT2i 或 GLP-1 RA\nDKA: T1DM、AG↑、Kussmaul breathing\nHHS: T2DM、極高血糖、高滲透壓、意識改變' },
        { title: '肺炎與抗生素', content: 'CAP 經驗治療：\n門診: Amoxicillin 或 Macrolide\n住院: β-lactam + Macrolide 或 Respiratory FQ\nICU: β-lactam + Macrolide/FQ\n\n非典型肺炎：Mycoplasma(年輕人、cold agglutinin)\nLegionella(空調、低血鈉、腹瀉)\n\nHAP/VAP: Broad spectrum → Piperacillin-tazobactam\n或 Cefepime 或 Carbapenem ± Vancomycin(MRSA risk)' },
        { title: '肝硬化併發症', content: '腹水：SAAG≥1.1 = 門脈高壓\n治療：限鈉+Spironolactone±Furosemide\nSBP：腹水PMN≥250 → Cefotaxime\nHepatic encephalopathy: Lactulose + Rifaximin\nVariceal bleeding: Octreotide + EBL\n預防: Propranolol(NSBB)\nHRS: type 1(急性)→Terlipressin+Albumin\nChild-Pugh / MELD score: 評估嚴重度' },
      ]
    },
    {
      id: 'surgery', icon: '🔪', name: '外科', color: '#3B82F6',
      cards: [
        { title: '急性腹痛鑑別', content: 'RUQ: 膽囊炎(Murphy sign)、膽管炎(Charcot triad)\nEpigastric: 胃潰瘍穿孔、急性胰臟炎\nRLQ: 闌尾炎(McBurney point、Psoas/Obturator sign)\nLLQ: 憩室炎(左側闌尾炎)\n瀰漫性: 腸阻塞、腸穿孔、腸繫膜缺血\n\n闌尾炎：臨床診斷為主，CT確認\n治療：Appendectomy(腹腔鏡)' },
        { title: '外傷處置 ATLS', content: 'Primary survey: ABCDE\nA: Airway + C-spine protection\nB: Breathing → tension pneumothorax(needle→chest tube)\nC: Circulation → 止血、輸液/輸血\nD: Disability → GCS、瞳孔\nE: Exposure → 全身檢查\n\nFAST: 腹部超音波找液體\nMassive transfusion: 1:1:1 (pRBC:FFP:Plt)\nDamage control surgery: 先止血→ICU穩定→再手術' },
        { title: '甲狀腺手術', content: '甲狀腺癌分類：\nPapillary: 最常見(80%)、Psammoma bodies、預後最好\nFollicular: 血行轉移(肺/骨)、需全切除+RAI\nMedullary: C cells → Calcitonin、MEN2相關\nAnaplastic: 最惡性、老年人、快速增大\n\n手術併發症：\n喉返神經損傷→聲音沙啞\n副甲狀腺損傷→低血鈣\n術後出血→呼吸道壓迫(緊急!)' },
      ]
    },
    {
      id: 'pediatrics', icon: '👶', name: '小兒科', color: '#F59E0B',
      cards: [
        { title: '新生兒黃疸', content: '生理性黃疸：出生後2-3天出現，1週內消退\n病理性黃疸警示：<24hr出現、>2週、direct>20%\n\n母乳性黃疸：\n早發(feeding): 餵食不足→脫水→腸肝循環↑\n晚發(breast milk): 2-3週，β-glucuronidase\n\n治療：照光療法(phototherapy)\n換血：bilirubin 極高有核黃疸(kernicterus)風險\nKernicterus: basal ganglia damage → 腦性麻痺' },
        { title: '兒童發燒處置', content: '<3個月發燒：高風險→全套檢查(CBC, U/A, blood cx, LP)\n3-36個月：外觀評估+尿液檢查\n>36個月：依症狀導向檢查\n\n常見原因：\nUTI: 嬰兒最常見細菌感染(無症狀只有發燒)\nAOM: 耳膜紅腫膨出→Amoxicillin\nPharyngitis: GAS→快篩+Penicillin\n\nFebrile seizure: 6m-5y，單純型(<15min)預後好' },
        { title: '川崎氏症 Kawasaki', content: '診斷：發燒≥5天 + 以下4/5\n1. 雙側非化膿性結膜炎\n2. 口腔黏膜變化(草莓舌、唇裂)\n3. 四肢變化(手腳腫脹→脫皮)\n4. 多形性皮疹\n5. 頸部淋巴結腫大(≥1.5cm)\n\n最嚴重併發症：冠狀動脈瘤\n治療：IVIG + 高劑量 Aspirin\n→ 之後低劑量 Aspirin 持續6-8週' },
      ]
    },
    {
      id: 'obstetrics_gynecology', icon: '🤰', name: '婦產科', color: '#EC4899',
      cards: [
        { title: '產前檢查時程', content: '第一孕期(11-13w)：\nNT(頸部透明帶)+PAPP-A+free β-hCG\n→ 唐氏症篩檢\n\n第二孕期(15-20w)：\n四指標：AFP, hCG, Estriol, Inhibin A\n↓AFP: Down syndrome\n↑AFP: NTD, 腹壁缺損\n\nNIPT: cfDNA，>99% sensitivity for T21\n確診：CVS(10-13w) 或 Amniocentesis(15-20w)' },
        { title: '子癇前症 Preeclampsia', content: '定義：妊娠20週後新發高血壓+蛋白尿(或器官損傷)\n風險因子：初產婦、多胞胎、慢性HTN、糖尿病\n\nSevere features：\nBP≥160/110、Plt<100K、肝酵素↑、腎Cr↑\n肺水腫、視覺/腦部症狀\n\nHELLP: Hemolysis + Elevated Liver + Low Platelet\n\n治療：MgSO₄(預防子癇)、降壓、終止妊娠(唯一根治)\n預防：高風險者12週起低劑量Aspirin' },
      ]
    },
    {
      id: 'psychiatry', icon: '🧠', name: '精神科', color: '#8B5CF6',
      cards: [
        { title: '思覺失調症', content: '陽性症狀：幻覺(聽幻覺最多)、妄想、思考障礙\n陰性症狀：情感平淡、社交退縮、無動力\n\n診斷：症狀≥6個月(活躍期≥1個月)\n\n治療：\n典型(first-gen): Haloperidol → EPS, tardive dyskinesia\n非典型(second-gen): Risperidone, Olanzapine, Clozapine\nClozapine: 難治型首選，但需監測WBC(agranulocytosis)\n\nEPS: 急性肌張力不全→Benztropine' },
        { title: '情緒障礙', content: 'MDD 診斷：≥5症狀持續≥2週(需含情緒低落或失去興趣)\nSIG E CAPS: Sleep, Interest, Guilt, Energy, Concentration, Appetite, Psychomotor, Suicide\n\n治療一線：SSRI (Fluoxetine, Sertraline)\n副作用：性功能障礙、GI不適、Serotonin syndrome\n\nBipolar I: 至少一次躁症發作\nBipolar II: 輕躁症+重鬱症\n治療：Lithium(需監測TSH、Cr)、Valproic acid' },
      ]
    },
    {
      id: 'neurology', icon: '⚡', name: '神經科', color: '#6366F1',
      cards: [
        { title: '中風分類與處置', content: 'Ischemic stroke (80%):\n黃金時間：Onset<4.5hr → IV tPA\n大血管阻塞：<24hr → 機械取栓\nAntiplatelet: Aspirin (急性期)\n\nHemorrhagic:\nICH: 高血壓最常見原因，BP control\nSAH: 劇烈頭痛(thunderclap)、Berry aneurysm\n→ CTA/DSA → Coiling/Clipping\n→ Nimodipine 預防 vasospasm\n\nTIA: <24hr，和 stroke 同樣需完整檢查' },
        { title: '癲癇與抗癲癇藥', content: 'Focal seizure: 意識保留或受損\nGeneralized: Absence(失神)、Tonic-clonic(大發作)\nStatus epilepticus: 持續>5min或反覆不停\n→ IV Lorazepam → Phenytoin/Fosphenytoin → 全身麻醉\n\n用藥選擇：\nFocal: Carbamazepine, Levetiracetam\nAbsence: Ethosuximide, Valproic acid\nJME: Valproic acid, Levetiracetam\n懷孕: Lamotrigine (最安全)' },
      ]
    },
    {
      id: 'dermatology', icon: '🧴', name: '皮膚科', color: '#F97316',
      cards: [
        { title: '藥物疹與嚴重藥物反應', content: 'SJS/TEN:\nSJS: BSA<10%, TEN: BSA>30%\n常見藥物：Allopurinol, Carbamazepine, Phenytoin, Sulfonamide\nHLA-B*5801(Allopurinol), HLA-B*1502(CBZ)\n→ 亞洲人用藥前需基因檢測\n\nDRESS: Drug Rash + Eosinophilia + Systemic Symptoms\n潛伏期：2-8週（比SJS長）\n肝炎最常見內臟侵犯' },
      ]
    },
    {
      id: 'orthopedics', icon: '🦴', name: '骨科', color: '#78716C',
      cards: [
        { title: '骨折分類與處置', content: '開放性骨折(Gustilo)：\nI: 傷口<1cm II: 1-10cm III: >10cm或嚴重污染\n→ 急診沖洗清創+抗生素+固定\n\n常見骨折：\nColles: 遠端橈骨(跌倒手撐)→dinner fork deformity\nScaphoid: 解剖鼻竇壓痛、AVN風險(血流差)\nHip fracture: 老年跌倒→股骨頸/轉子間\n→ 股骨頸移位→人工關節、轉子間→ORIF\n\nCompartment syndrome: 5P(Pain, Pressure, Paresthesia, Paralysis, Pulselessness) → 緊急筋膜切開' },
      ]
    },
    {
      id: 'urology', icon: '🫘', name: '泌尿科', color: '#0EA5E9',
      cards: [
        { title: '泌尿道結石', content: 'Calcium oxalate: 最常見(80%)、X光可見\nStruvite(磷酸銨鎂): 感染石、Proteus(urease+)、鹿角狀\nUric acid: X光不可見、痛風、酸性尿\nCystine: 六角形結晶、遺傳\n\n處置：\n<5mm: 保守(多喝水+止痛)，多數自行排出\n5-10mm: α-blocker(MET)促排石\n>10mm 或阻塞感染: ESWL / URS / PCNL\n\n腎絞痛：突發劇烈腰痛→鼠蹊部放射' },
      ]
    },
    {
      id: 'anesthesia', icon: '😴', name: '麻醉科', color: '#64748B',
      cards: [
        { title: '術前評估與氣道', content: 'ASA分級：\nI: 健康 II: 輕度全身疾病 III: 嚴重全身疾病\nIV: 持續威脅生命 V: 瀕死 VI: 腦死器捐\n\nMallampati 分級：\nI: 可見軟顎+懸壅垂+咽弓\nII: 軟顎+部分懸壅垂\nIII: 只見軟顎\nIV: 只見硬顎 → 困難插管\n\n困難氣道：3-3-2 rule、頸部活動度、門牙突出' },
      ]
    },
    {
      id: 'ophthalmology', icon: '👁️', name: '眼科', color: '#06B6D4',
      cards: [
        { title: '急性眼科急症', content: '急性閉角型青光眼：\n瞳孔半散大固定、眼壓極高(>40)、角膜水腫\n頭痛噁吐、看燈光有虹暈\n→ 緊急降眼壓+雷射虹膜切開\n\n視網膜剝離：\n閃光(photopsia)+飛蚊症→視野缺損如布幕遮蔽\n→ 緊急轉診眼科手術\n\n中央視網膜動脈阻塞(CRAO):\n突發無痛視力喪失、cherry-red spot\n→ 眼科急症，黃金90分鐘' },
      ]
    },
    {
      id: 'ent', icon: '👂', name: '耳鼻喉科', color: '#A855F7',
      cards: [
        { title: '眩暈鑑別', content: '周邊性(內耳)：\nBPPV: 最常見、姿勢變換誘發、Dix-Hallpike(+)\n→ Epley maneuver\nMeniere: 發作性眩暈+聽力喪失+耳鳴+耳脹\n→ 限鈉、利尿劑\nVestibular neuritis: 急性持續眩暈、聽力正常\n\n中樞性(腦幹/小腦)：\n方向改變的nystagmus、神經學徵兆\n→ 需排除中風(HINTS test)\n\n周邊 vs 中樞：有無聽力問題、nystagmus特性' },
      ]
    },
    {
      id: 'rehabilitation', icon: '🏃', name: '復健科', color: '#22C55E',
      cards: [
        { title: '中風復健', content: '急性期(ICU/病房)：\n48hr內開始床邊復健、ROM運動、翻身預防褥瘡\n\n亞急性期(復健病房)：\n密集復健(3hr/day): PT + OT + ST\nBrunnstrom stages: I(弛緩)→VI(正常)\n\n常見併發症：\n肩關節半脫位：吊帶+電刺激\n肩手症候群(CRPS): 手腫痛→早期活動\n痙攣：Baclofen, Botox, 伸展\n吞嚥困難：VFSS評估→飲食質地調整' },
      ]
    },
    {
      id: 'medical_law_ethics', icon: '⚖️', name: '醫學倫理', color: '#78716C',
      cards: [
        { title: '四大倫理原則', content: '1. 自主(Autonomy): 知情同意、拒絕治療權\n2. 行善(Beneficence): 為病人最大利益\n3. 不傷害(Non-maleficence): Primum non nocere\n4. 正義(Justice): 資源公平分配\n\n知情同意要素：\n- 資訊揭露(診斷、治療、風險、替代方案)\n- 病人理解能力\n- 自願性(無脅迫)\n- 決定能力(competence)\n\n例外：緊急情況、病人無行為能力且無代理人' },
      ]
    },
  ],

  dental1: [
    { id: 'dental_anatomy', icon: '🦷', name: '牙醫解剖', color: '#3B82F6', cards: [
      { title: '頭頸部神經', content: '三叉神經(CN V)三分支：\nV1 眼支: 額部、上眼瞼\nV2 上頜支: 上排牙齒、上唇、頰\nV3 下頜支: 下排牙齒、下唇、舌前2/3感覺\n\n下齒槽神經阻斷麻醉(IANB)：\n目標: inferior alveolar nerve\n注射位置: mandibular foramen 上方\n麻醉範圍: 同側下排牙齒+下唇+下巴\n併發症: 舌神經損傷→舌麻木' },
      { title: '咀嚼肌', content: '閉口肌(舉下顎)：\nMasseter: 最強咀嚼肌\nTemporalis: 扇形，顳窩\nMedial pterygoid: 深層閉口\n\n開口肌(降下顎)：\nLateral pterygoid: 開口+前突+側方運動\nDigastric, Mylohyoid, Geniohyoid\n\nTMJ:\n雙軸關節、關節盤分上下腔\n開口: 先旋轉(下腔)→再滑動(上腔)\nTMD: 疼痛、彈響、開口受限' },
    ]},
    { id: 'tooth_morphology', icon: '🪥', name: '牙體形態', color: '#10B981', cards: [
      { title: '永久齒辨識要點', content: '上顎第一大臼齒(#14/#16)：\n最大的牙齒、4咬頭(MB,DB,ML,DL)+Cusp of Carabelli\n3個根(MB,DB,P)，腭側根最大\n\n下顎第一大臼齒(#36/#46)：\n最早萌出的永久齒(~6歲)\n5咬頭、2根(M,D)\n\n上顎犬齒：最長的牙齒(根)\n下顎中門齒：最小的永久齒\n\n齒式：FDI(11-48)、Universal(1-32)' },
    ]},
    { id: 'embryology_histology', icon: '🧫', name: '胚胎組織', color: '#8B5CF6', cards: [
      { title: '牙齒發育階段', content: 'Bud stage → Cap stage → Bell stage → Maturation\n\n四大組織來源：\nEnamel: 外胚層(ameloblast) — 唯一外胚層\nDentin: neural crest(odontoblast)\nCementum: neural crest(cementoblast)\nPulp: neural crest\n\nHertwig epithelial root sheath(HERS):\n決定牙根形態\n殘餘→Malassez epithelial rests\n→ 根尖囊腫(radicular cyst)來源' },
    ]},
    { id: 'oral_pathology', icon: '🔬', name: '口腔病理', color: '#EF4444', cards: [
      { title: '口腔常見病灶', content: 'Odontogenic cysts:\nRadicular cyst: 最常見、壞死牙髓\nDentigerous cyst: 含齒囊腫、未萌牙冠周圍\nOKC(Keratocyst): 高復發率、Gorlin syndrome\n\nOdontogenic tumors:\nAmeloblastoma: 最常見、下顎後方、soap bubble\nOdontoma: 最常見良性、compound/complex\n\n白斑(Leukoplakia): 排除診斷、5%惡性轉化\n紅斑(Erythroplakia): 惡性率更高(>50%)' },
    ]},
    { id: 'oral_physiology', icon: '⚡', name: '口腔生理', color: '#F59E0B', cards: [
      { title: '唾液與咀嚼', content: '唾液分泌量: 0.5-1.5 L/day\n成分: 99.5% 水 + 酵素 + 電解質\nAmylase: 澱粉分解\nLysozyme, IgA: 抗菌\nMucin: 潤滑\n\n三大唾液腺：\nParotid: 純漿液性、Stensen duct\nSubmandibular: 混合(漿>黏)、Wharton duct、分泌量最多\nSublingual: 混合(黏>漿)\n\n副交感刺激 → 大量稀薄唾液\n交感刺激 → 少量黏稠唾液' },
    ]},
    { id: 'dental_microbiology', icon: '🦠', name: '微免', color: '#14B8A6', cards: [
      { title: '齲齒微生物學', content: 'S. mutans: 齲齒主要致病菌\n→ 產酸(lactic acid)、合成glucan(附著)\n→ 酸性環境存活(aciduric + acidogenic)\n\nLactobacillus: 齲齒進展相關\nActinomyces: 根面齲齒\n\n牙周病原菌 Red complex:\nP. gingivalis: 慢性牙周炎主角\nT. forsythia\nT. denticola\n\nA. actinomycetemcomitans: 侵襲性牙周炎' },
    ]},
    { id: 'dental_pharmacology', icon: '💊', name: '牙科藥理', color: '#EC4899', cards: [
      { title: '局部麻醉劑', content: 'Amide type (-caine): Lidocaine, Articaine, Bupivacaine\nEster type: Procaine, Benzocaine\n\nLidocaine 2% + 1:100,000 Epi:\n最常用、onset 2-3 min、duration 60min(軟組織更久)\n最大劑量: 4.4 mg/kg (with epi: 7 mg/kg)\n\nArticaine 4%: 骨滲透佳→可用頰側浸潤取代IANB\nBupivacaine: 長效(術後止痛)\n\n毒性: CNS興奮→抑制→心律不整\n禁忌: Epi → 未控制甲亢、MAOi' },
    ]},
  ],

  dental2: [
    { id: 'endodontics', icon: '🦷', name: '牙髓病', color: '#EF4444', cards: [
      { title: '牙髓診斷', content: '可逆性牙髓炎: 冷刺激短暫疼痛、移除後消失\n不可逆性牙髓炎: 自發性疼痛、冷熱持續痛、夜間痛\n牙髓壞死: 無活力、可能無症狀或有膿腫\n\n測試：\nCold test (EPT): 活力測試\nPercussion: 根尖周炎\nPalpation: 膿腫\nX-ray: 根尖透射影像(radiolucency)\n\n根管治療步驟：\n開髓→清創整形→沖洗(NaOCl)→充填(Gutta-percha)→贋復' },
    ]},
    { id: 'operative_dentistry', icon: '🔧', name: '牙體復形', color: '#3B82F6', cards: [
      { title: '複合樹脂修復', content: 'Composite resin 組成：\nMatrix: Bis-GMA, UDMA\nFiller: silica, glass (決定強度)\nCoupling agent: silane\n\n黏著系統：\nEtch-and-rinse: 37% H₃PO₄ → primer → adhesive\nSelf-etch: 酸+primer合一\n\nC-factor (Configuration factor):\n黏著面/自由面 → C-factor越高聚合收縮應力越大\n→ 分層充填(incremental technique)降低' },
    ]},
    { id: 'periodontics', icon: '🩸', name: '牙周病', color: '#10B981', cards: [
      { title: '牙周病分期', content: '2017 新分類：\nStage I: 初期，CAL 1-2mm\nStage II: 中度，CAL 3-4mm\nStage III: 重度+複雜，CAL≥5mm，骨喪失≥中1/3根\nStage IV: 極重度+複雜，需全口重建\n\nGrade: A(慢)、B(中)、C(快速進展)\n→ 依bone loss/age比值判定\n\n治療：\n非手術: OHI + SRP(scaling & root planing)\n手術: flap surgery, GTR, bone graft\n維護期: 3-6個月recall' },
    ]},
    { id: 'oral_surgery', icon: '🔪', name: '口腔顎面外科', color: '#F59E0B', cards: [
      { title: '智齒拔除', content: 'Winter分類(下顎阻生智齒)：\nMessioangular: 最常見、最容易拔\nHorizontal: 第二困難\nVertical: 相對容易\nDistoangular: 最困難\n\nPell & Gregory:\nClass I/II/III: 與ramus關係\nPosition A/B/C: 與第二大臼齒咬合面關係\n\n併發症：\n下齒槽神經損傷→下唇麻木\n舌神經損傷→舌麻木\n乾性齒槽(dry socket): 3-5天劇痛' },
    ]},
    { id: 'dental_radiology', icon: '📷', name: '口腔影像', color: '#6366F1', cards: [
      { title: '影像判讀基礎', content: 'Radiopaque(白): 金屬、牙釉質、骨\nRadiolucent(黑): 空氣、軟組織、病灶\n\n常用影像：\nPeriapical: 根尖病灶、齲齒\nBitewing: 鄰接面齲齒、牙槽骨頂\nPanoramic(OPG): 全口概觀\nCBCT: 3D，植牙規劃、阻生齒、TMJ\n\n輻射劑量：PA < BW < Pano < CBCT < Medical CT\nALARA原則: As Low As Reasonably Achievable' },
    ]},
    { id: 'removable_prosthodontics', icon: '🦷', name: '活動補綴', color: '#EC4899', cards: [
      { title: '全口義齒', content: 'Complete denture 製作步驟：\n1. 初印模(alginate)→研究模型\n2. 個人托盤→終印模(ZOE/rubber)\n3. 咬合紀錄(wax rim)→面弓轉移\n4. 排牙→試戴\n5. 裝戴→調整\n\n穩定與固位：\n吸附力、大氣壓力、肌肉控制\n上顎 > 下顎(固位面積)\n\n常見問題：\nGagging → 後緣短縮\n發音問題 → 前牙位置/腭厚度調整' },
    ]},
    { id: 'dental_materials', icon: '🧪', name: '牙科材料', color: '#14B8A6', cards: [
      { title: '印模材料比較', content: 'Alginate(藻膠):\n不可逆水膠體、便宜快速\n精確度中等、不能延遲灌模\n\nAddition silicone(PVS):\n最精確、尺寸穩定性最佳\n疏水→需用surfactant\n\nCondensation silicone:\n較便宜、但會收縮(副產物揮發)\n\nPolyether:\n精確、親水性佳\n但硬、不易脫模、吸水膨脹\n\n選擇原則：精度要求高→PVS\n初印模/study model→Alginate' },
    ]},
    { id: 'fixed_prosthodontics', icon: '👑', name: '固定補綴', color: '#F97316', cards: [
      { title: '牙冠製備原則', content: '全瓷冠製備：\n咬合面: 1.5-2mm\n軸面: 1.0-1.5mm\nMargin: chamfer 或 shoulder\n\nPFM(金屬燒瓷冠)：\n軸面: 1.0-1.5mm\n舌側可做 metal collar\nMargin: chamfer\n\n收斂角(taper): 總收斂角 10-20°\n→ 過大: 固位力↓\n→ 過小: 就位困難\n\n支台齒高度≥4mm, 抗力型(resistance form)重要' },
    ]},
    { id: 'orthodontics', icon: '😁', name: '齒顎矯正', color: '#8B5CF6', cards: [
      { title: 'Angle 分類', content: 'Class I: 上顎第一大臼齒MB cusp對下顎第一大臼齒buccal groove\n→ 正常咬合關係、可能有crowding\n\nClass II (遠心咬合):\nDiv 1: 上門齒前突(overjet↑)\nDiv 2: 上門齒後傾(deep bite)\n→ 下顎後縮 or 上顎前突\n\nClass III (近心咬合):\n下顎前突 → underbite\n→ 可能需手術矯正(orthognathic surgery)\n\nOverjet: 水平覆蓋\nOverbite: 垂直覆蓋' },
    ]},
    { id: 'pediatric_dentistry', icon: '👶', name: '兒童牙科', color: '#22C55E', cards: [
      { title: '乳牙外傷處置', content: '乳門齒外傷(最常見1-3歲跌倒)：\n\n脫位(luxation):\n輕度→觀察\n嚴重嵌入→若向唇側：觀察等自然萌出\n　　　　→若向發育中恆牙：拔除\n\n完全脫落(avulsion):\n乳牙不植回！(避免傷害恆牙胚)\n\n恆牙外傷(avulsion):\n→ 立即植回！(黃金30分鐘)\n保存：牛奶、生理食鹽水、口中(頰側)\n→ 植回+固定(flexible splint 2週)\n→ 追蹤根管治療' },
    ]},
    { id: 'dental_public_health', icon: '🏥', name: '公衛', color: '#84CC16', cards: [
      { title: '齲齒指數', content: 'DMFT/dmft:\nD(decayed) + M(missing) + F(filled) Teeth\n大寫=恆牙、小寫=乳牙\n\n台灣兒童齲齒盛行率仍偏高\n6歲 dmft ~5.44\n12歲 DMFT ~2.5\n\n預防措施：\n氟化物：飲水加氟(0.7ppm)、氟漆、含氟牙膏(1000ppm+)\n窩溝封填(sealant): 第一大臼齒萌出後\n定期檢查: 每6個月\n飲食: 減少含糖食物頻率' },
    ]},
    { id: 'dental_ethics_law', icon: '⚖️', name: '倫理法規', color: '#78716C', cards: [
      { title: '牙醫師法重點', content: '執業登記：領證後需向衛生局申請\n業務範圍：牙齒疾病診治、口腔手術、X光\n病歷保存：至少7年\n\n醫療糾紛：\n民事：損害賠償(過失責任)\n刑事：業務過失傷害/致死\n行政：衛生局裁罰\n\n知情同意：手術/侵入性治療需書面\n轉診義務：超出能力範圍應轉診\n通報義務：傳染病、兒虐' },
    ]},
  ],

  pharma1: [
    { id: 'pharmacology', icon: '💊', name: '藥理學', color: '#EF4444', cards: [
      { title: '藥物動力學基礎', content: '吸收：口服生體可用率(F) = AUC(oral)/AUC(IV)\n首渡效應(first-pass): 肝臟代謝→F↓\n\n分布：Vd = Dose/Cp\nVd大→組織分布廣(如 Chloroquine)\nVd小→血漿蛋白結合高(如 Warfarin)\n\n代謝：Phase I(CYP450 oxidation) → Phase II(conjugation)\nCYP3A4: 代謝最多藥物\n誘導劑：Rifampin, Phenytoin, Carbamazepine\n抑制劑：Ketoconazole, Erythromycin, Grapefruit\n\n排除：t½ = 0.693/ke' },
      { title: '受體藥理學', content: 'Agonist: 結合受體產生最大反應(efficacy=1)\nPartial agonist: 結合但最大反應<full agonist\nAntagonist: 結合不產生反應、阻斷agonist\n\nCompetitive: 右移dose-response curve、可被高劑量overcome\nNon-competitive: 降低Emax、不可overcome\n\nTherapeutic index: TI = TD₅₀/ED₅₀\nTI越大越安全\n窄TI藥物：Lithium, Digoxin, Warfarin, Theophylline, Phenytoin\n→ 需監測血中濃度(TDM)' },
    ]},
    { id: 'medicinal_chemistry', icon: '⚗️', name: '藥物化學', color: '#8B5CF6', cards: [
      { title: 'SAR 基礎概念', content: 'Structure-Activity Relationship:\n藥物結構決定其藥理活性\n\nPharmacophore: 產生藥理活性的最小結構特徵\nBioisostere: 相似理化性質的替換基團\n→ 經典: -OH ↔ -NH₂, -COOH ↔ -SO₂NH₂\n\nProdrug: 體內代謝後才有活性\n例: Enalapril→Enalaprilat, Codeine→Morphine\n\nChirality: 手性碳→對映異構物可能活性不同\n例: S-omeprazole(esomeprazole)比R活性強' },
    ]},
    { id: 'pharmaceutical_analysis', icon: '📊', name: '藥物分析', color: '#3B82F6', cards: [
      { title: '分析方法', content: 'UV-Vis 分光光度法：\nBeer-Lambert Law: A = εbc\n定量分析基礎、簡單快速\n\nHPLC(高效液相層析)：\n最常用的分離分析法\nReverse phase: C18管柱+有機溶劑\n→ 非極性物質滯留較久\n\nGC(氣相層析): 揮發性物質\nMass spectrometry: 結構鑑定、高靈敏\n\n藥典方法驗證：\nAccuracy, Precision, Specificity, Linearity, LOD, LOQ' },
    ]},
    { id: 'pharmacognosy', icon: '🌿', name: '生藥學', color: '#22C55E', cards: [
      { title: '重要生藥', content: 'Alkaloids(生物鹼)：\nMorphine(罌粟)、Atropine(顛茄)、Caffeine(茶/咖啡)\nQuinine(金雞納)→抗瘧疾\nVincristine/Vinblastine(長春花)→抗癌\n\nGlycosides(配醣體)：\nDigoxin(毛地黃)→強心\nSennoside(番瀉葉)→瀉劑\n\nTerpenes:\nArtemisinin(青蒿素)→抗瘧疾\nPaclitaxel(太平洋紫杉)→抗癌\n\n品質管制：TLC指紋圖譜、含量測定' },
    ]},
    { id: 'pharmaceutics', icon: '💉', name: '藥劑學', color: '#F59E0B', cards: [
      { title: '劑型與藥物輸送', content: '口服固體劑型釋放順序：\n溶液 > 懸液 > 膠囊 > 錠劑 > 腸溶錠\n\n錠劑製造：\n濕式造粒(wet granulation)→最常用\n直接壓錠(direct compression)→熱敏感藥物\n\n腸溶衣: pH>5.5溶解→保護胃或腸道吸收\n控釋劑型: 減少給藥頻率、穩定血中濃度\n\n注射劑無菌要求：\nIV: 必須完全澄清、無微粒\n滅菌: 高壓蒸氣(121°C, 15min)最可靠\n無法耐熱→無菌過濾(0.22μm)' },
    ]},
    { id: 'biopharmaceutics', icon: '🧬', name: '生物藥劑學', color: '#EC4899', cards: [
      { title: 'BCS 分類系統', content: 'Biopharmaceutics Classification System:\nClass I: 高溶解+高滲透 → 最佳口服吸收\nClass II: 低溶解+高滲透 → 溶離速率限制\nClass III: 高溶解+低滲透 → 滲透限制\nClass IV: 低溶解+低滲透 → 口服吸收差\n\n生體相等性(Bioequivalence):\nAUC, Cmax, Tmax 比較\n80-125% 信賴區間→BE通過\n→ 學名藥上市必須證明與原廠BE\n\n影響吸收因素：\npKa、脂溶性、分子量、P-gp外排' },
    ]},
  ],

  pharma2: [
    { id: 'dispensing', icon: '📋', name: '調劑學', color: '#3B82F6', cards: [
      { title: '處方判讀與調劑', content: '處方必要項目：\n病人資料、醫師簽章、藥品名稱劑量頻次\n\n常見縮寫：\nac(飯前)、pc(飯後)、hs(睡前)\nBID(每日兩次)、TID(三次)、QID(四次)\nQD(每日一次)、PRN(需要時)\n\n高警訊藥品(LASA)：\n外觀/發音相似藥品→需特別標示\n如：Losec(PPI) vs Lasix(利尿劑)\n\n調劑三核對：\n處方核對→調配→覆核→交付(用藥指導)' },
    ]},
    { id: 'clinical_pharmacy', icon: '🏥', name: '臨床藥學', color: '#8B5CF6', cards: [
      { title: '藥物交互作用', content: '藥物動力學交互作用：\nCYP450 誘導/抑制 → 血中濃度改變\nWarfarin + Rifampin → ↓INR(誘導代謝)\nWarfarin + Fluconazole → ↑INR(抑制代謝)\n\n藥效學交互作用：\nACEI + K-sparing diuretic → 高血鉀\nNSAID + Warfarin → 出血風險↑\n\nQT prolongation:\nMacrolides, FQ, Antipsychotics, Antiarrhythmics\n→ Torsades de pointes 風險\n\n腎功能調整：\nCrCl計算(Cockcroft-Gault) → 劑量調整' },
    ]},
    { id: 'pharmacotherapy', icon: '💊', name: '藥物治療', color: '#EF4444', cards: [
      { title: '高血壓藥物治療', content: '一線藥物：\nACEI(-pril) / ARB(-sartan)\nCCB(Amlodipine)\nThiazide(HCTZ)\n\n特殊情況首選：\nDM+蛋白尿: ACEI/ARB\n心衰竭: ACEI/ARB + β-blocker + MRA\n懷孕: Methyldopa, Labetalol\n\n禁忌：\nACEI/ARB: 懷孕、雙側腎動脈狹窄、高血鉀\nβ-blocker: 氣喘、心搏過緩\nThiazide: 痛風\n\n目標: <130/80 mmHg (一般成人)' },
      { title: '抗凝血藥物', content: 'Warfarin:\nVit K antagonist → II, VII, IX, X\n監測: INR (目標 2-3, 機械瓣膜 2.5-3.5)\n解毒: Vit K(慢), FFP/PCC(快)\n\nHeparin:\nAT-III 增強 → 抑制 thrombin + Xa\n監測: aPTT\n解毒: Protamine sulfate\nHIT: heparin-induced thrombocytopenia\n\nDOAC:\nDabigatran(thrombin抑制): Idarucizumab解毒\nRivaroxaban, Apixaban(Xa抑制): Andexanet alfa\n不需常規監測、腎功能注意' },
    ]},
    { id: 'pharmacy_law', icon: '⚖️', name: '藥事法規', color: '#78716C', cards: [
      { title: '藥事法重點', content: '藥品分級：\n處方藥(Rx): 需醫師處方\n指示藥(OTC-I): 藥師指示\n成藥(OTC-II): 可自行購買\n\n管制藥品分四級：\n第一級: 海洛因(最嚴格)\n第二級: 嗎啡、古柯鹼、安非他命\n第三級: FM2、Ketamine\n第四級: Diazepam, Zolpidem\n\n藥師業務：\n調劑、藥品管理、用藥諮詢、藥事照護\n\n藥局設置: 需有藥師駐店、親自執行業務\nGMP: 藥品製造規範' },
    ]},
  ],
}

// ── Components ──────────────────────────────────────────────────

// Community note card (user-created)
function CommunityCard({ note, exam, subject, onDelete, onLikeUpdate }) {
  const [expanded, setExpanded] = useState(false)
  const [likedIds, setLikedIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cnote-likes') || '[]') } catch { return [] }
  })
  const [reportedIds, setReportedIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cnote-reports') || '[]') } catch { return [] }
  })
  const userId = getUserId()
  const isMine = note.userId === userId

  const handleLike = async () => {
    try {
      const res = await fetch(`${BACKEND}/community-notes/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exam, subject, noteId: note.id, userId }),
      })
      const data = await res.json()
      if (data.ok) {
        const newLiked = data.liked ? [...likedIds, note.id] : likedIds.filter(id => id !== note.id)
        setLikedIds(newLiked)
        localStorage.setItem('cnote-likes', JSON.stringify(newLiked))
        onLikeUpdate?.(note.id, data.likes)
      }
    } catch {}
  }

  const handleReport = async () => {
    if (reportedIds.includes(note.id)) return
    if (!confirm('確定要檢舉此筆記嗎？')) return
    try {
      await fetch(`${BACKEND}/community-notes/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exam, subject, noteId: note.id, userId }),
      })
      const newReported = [...reportedIds, note.id]
      setReportedIds(newReported)
      localStorage.setItem('cnote-reports', JSON.stringify(newReported))
    } catch {}
  }

  const handleDelete = async () => {
    if (!confirm('確定要刪除這張筆記嗎？')) return
    try {
      const res = await fetch(`${BACKEND}/community-notes/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exam, subject, noteId: note.id, userId }),
      })
      const data = await res.json()
      if (data.ok) onDelete?.(note.id)
    } catch {}
  }

  return (
    <div className="w-full text-left bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 active:scale-[0.98] transition-all">
        <span className="text-lg">{note.avatar}</span>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm text-medical-dark truncate">{note.title}</p>
          <p className="text-xs text-gray-400">{note.name} · {timeAgo(note.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {note.likes > 0 && <span className="text-xs text-red-400">❤️ {note.likes}</span>}
          <span className={`text-gray-300 text-lg transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-0">
          <div className="bg-medical-ice rounded-xl px-4 py-3">
            <pre className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap font-[inherit]">{note.content}</pre>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button onClick={handleLike}
              className={`flex items-center gap-1 text-xs active:scale-95 transition-transform ${likedIds.includes(note.id) ? 'text-red-500' : 'text-gray-400'}`}>
              {likedIds.includes(note.id) ? '❤️' : '🤍'} {note.likes > 0 ? note.likes : '讚'}
            </button>
            {isMine ? (
              <button onClick={handleDelete} className="text-xs text-red-400 active:scale-95">🗑 刪除</button>
            ) : !reportedIds.includes(note.id) ? (
              <button onClick={handleReport} className="text-xs text-gray-300 active:scale-95">🚩</button>
            ) : (
              <span className="text-xs text-gray-300">已檢舉</span>
            )}
          </div>
          <CommentSection targetId={`cnote_${note.id}`} />
        </div>
      )}
    </div>
  )
}

// Community notes section for a subject
function CommunityNotes({ exam, subjectId }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')

  const name = usePlayerStore(s => s.name) || '匿名'
  const avatar = usePlayerStore(s => s.avatar) || '👤'
  const userId = getUserId()

  const fetchNotes = useCallback(() => {
    fetch(`${BACKEND}/community-notes?exam=${exam}&subject=${subjectId}`)
      .then(r => r.json())
      .then(data => { setNotes(data.notes || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [exam, subjectId])

  useEffect(() => { fetchNotes() }, [fetchNotes])

  const handlePost = async () => {
    if (!title.trim() || !content.trim() || posting) return
    setPosting(true)
    setError('')
    try {
      const res = await fetch(`${BACKEND}/community-notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exam, subject: subjectId, title: title.trim(), content: content.trim(), name, avatar, userId }),
      })
      const data = await res.json()
      if (data.ok) {
        setNotes(prev => [data.note, ...prev])
        setTitle('')
        setContent('')
        setShowForm(false)
      } else {
        setError(data.error || '發送失敗')
      }
    } catch { setError('網路錯誤') }
    setPosting(false)
  }

  const handleDelete = (noteId) => {
    setNotes(prev => prev.filter(n => n.id !== noteId))
  }

  const handleLikeUpdate = (noteId, newLikes) => {
    setNotes(prev => prev.map(n => n.id === noteId ? { ...n, likes: newLikes } : n))
  }

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gray-700">✍️ 社群筆記</span>
          <span className="text-xs text-gray-400">{notes.length} 張</span>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="text-xs font-bold text-medical-blue bg-medical-ice px-3 py-1.5 rounded-xl active:scale-95">
          {showForm ? '取消' : '+ 寫筆記'}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl border border-medical-blue/20 p-4 mb-3 shadow-sm">
          <input type="text" value={title} onChange={e => setTitle(e.target.value)}
            placeholder="標題（最多 50 字）" maxLength={50}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm mb-2 outline-none focus:border-medical-blue" />
          <textarea value={content} onChange={e => setContent(e.target.value)}
            placeholder="寫下你的筆記重點、口訣、心得...（最多 2000 字）" maxLength={2000} rows={5}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none outline-none focus:border-medical-blue" />
          {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-gray-400">{content.length}/2000</p>
            <button onClick={handlePost} disabled={!title.trim() || !content.trim() || posting}
              className="px-4 py-2 rounded-xl text-sm font-bold text-white grad-cta active:scale-95 disabled:opacity-40">
              {posting ? '發送中...' : '發表筆記'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-300 text-xs py-4">載入中...</div>
      ) : notes.length === 0 ? (
        <div className="text-center text-gray-300 text-xs py-6">
          還沒有社群筆記，來當第一個分享的人吧！
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {notes.map(note => (
            <CommunityCard key={note.id} note={note} exam={exam} subject={subjectId}
              onDelete={handleDelete} onLikeUpdate={handleLikeUpdate} />
          ))}
        </div>
      )}
    </div>
  )
}

function NoteCard({ card, index, subjectId }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="w-full text-left bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 active:scale-[0.98] transition-all">
        <span className="w-7 h-7 rounded-lg bg-medical-ice text-medical-blue text-xs font-bold flex items-center justify-center shrink-0">
          {index + 1}
        </span>
        <p className="font-bold text-sm text-medical-dark flex-1">{card.title}</p>
        <span className={`text-gray-300 text-lg transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-0">
          <div className="bg-medical-ice rounded-xl px-4 py-3">
            <pre className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap font-[inherit]">{card.content}</pre>
          </div>
          <CommentSection targetId={`note_${subjectId}_${index}`} />
        </div>
      )}
    </div>
  )
}

export default function Notes() {
  const navigate = useNavigate()
  const exam = usePlayerStore(s => s.exam) || 'doctor1'
  const subjects = NOTES[exam] || NOTES.doctor1
  const [selectedSubject, setSelectedSubject] = useState(null)

  if (selectedSubject) {
    const subj = subjects.find(s => s.id === selectedSubject)
    if (!subj) { setSelectedSubject(null); return null }
    return (
      <div className="flex flex-col min-h-dvh bg-medical-ice">
        <div className="sticky top-0 z-10 px-4 pt-12 pb-4 grad-header">
          <div className="flex items-center gap-3">
            <button onClick={() => setSelectedSubject(null)} className="text-white/60 text-2xl leading-none">‹</button>
            <div className="flex-1">
              <h1 className="text-white font-bold text-xl">{subj.icon} {subj.name}</h1>
              <p className="text-white/50 text-xs">{subj.cards.length} 張精華卡</p>
            </div>
            <button onClick={() => navigate('/practice')}
              className="bg-white/15 text-white text-xs font-bold px-3 py-1.5 rounded-xl active:scale-95">
              去練習 →
            </button>
          </div>
        </div>

        <div className="flex-1 px-4 py-4 flex flex-col gap-2.5">
          {subj.cards.map((card, i) => (
            <NoteCard key={i} card={card} index={i} subjectId={subj.id} />
          ))}

          <div className="bg-amber-50 rounded-2xl p-4 border border-amber-200 mt-2">
            <p className="text-amber-800 font-bold text-sm">💡 學習建議</p>
            <p className="text-amber-700 text-xs mt-1 leading-relaxed">
              先看完精華卡建立整體架構，再去「自主練習」用題目驗證理解。答錯的題目會自動加入錯題本，之後間隔複習效果更好。
            </p>
          </div>

          <CommunityNotes exam={exam} subjectId={subj.id} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="sticky top-0 z-10 px-4 pt-12 pb-4 grad-header">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-white/60 text-2xl leading-none">‹</button>
          <div>
            <h1 className="text-white font-bold text-xl">📒 精華筆記</h1>
            <p className="text-white/50 text-xs">{subjects.length} 大科目高頻考點速記</p>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-2.5">
        {subjects.map((subj) => (
          <button key={subj.id} onClick={() => setSelectedSubject(subj.id)}
            className="w-full text-left bg-white rounded-2xl px-5 py-4 border border-gray-100 shadow-sm transition-all active:scale-[0.97]">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
                   style={{ backgroundColor: subj.color + '15' }}>
                {subj.icon}
              </div>
              <div className="flex-1">
                <p className="font-bold text-base text-medical-dark">{subj.name}</p>
                <p className="text-gray-400 text-xs mt-0.5">{subj.cards.length} 張精華卡 · {subj.cards.map(c => c.title).slice(0, 2).join('、')}{subj.cards.length > 2 ? '…' : ''}</p>
              </div>
              <span className="text-gray-300 text-xl">›</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
