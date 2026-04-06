import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const SUBJECTS = [
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
    id: 'pharmacology', icon: '💊', name: '藥理學', color: '#F59E0B',
    cards: [
      { title: '自主神經藥物', content: '交感 α1: 血管收縮 → Phenylephrine(作動), Prazosin(拮抗)\nα2: 突觸前抑制 → Clonidine(中樞降壓)\nβ1: 心臟(↑HR, ↑contractility) → Dobutamine(作動)\nβ2: 支氣管擴張 → Salbutamol(作動)\n副交感 M: Atropine(拮抗), Pilocarpine(作動)\nAChE inhibitor: Neostigmine(可逆), Organophosphate(不可逆→pralidoxime)' },
      { title: '抗生素分類', content: '抑制細胞壁：β-lactams(Penicillin, Ceph, Carbapenem), Vancomycin\n抑制蛋白質合成 30S: Aminoglycosides, Tetracycline\n抑制蛋白質合成 50S: Macrolides, Chloramphenicol, Clindamycin\n口訣：「Buy AT 30, CEL at 50」\n抑制 DNA: Fluoroquinolones(DNA gyrase), Metronidazole\n抑制葉酸: TMP-SMX\nMRSA: Vancomycin, Linezolid, Daptomycin' },
      { title: '心血管藥物', content: 'Anti-HTN 一線：ACEI/ARB, CCB, Thiazide\nACEI: -pril → 乾咳(bradykinin)、高血鉀、禁用孕婦\nARB: -sartan → 比ACEI少咳嗽\nCCB: Amlodipine(血管), Verapamil/Diltiazem(心臟)\nβ-blocker: Metoprolol(β1選擇), Carvedilol(α+β)\nStatins: 抑制 HMG-CoA reductase → ↓LDL，副作用: 橫紋肌溶解\nAnticoagulant: Heparin(APTT), Warfarin(PT/INR)' },
      { title: '止痛與麻醉', content: 'NSAIDs: 抑制 COX → ↓PG\nCOX-1: 保護胃黏膜、血小板 TXA2\nCOX-2: 發炎、疼痛\nAspirin: 不可逆抑制 COX → 低劑量抗血小板\nOpioids: μ receptor → morphine, fentanyl\n副作用: 呼吸抑制、便秘、瞳孔縮小\nNaloxone: μ antagonist → 解毒\nLocal anesthetics: 阻斷 Na⁺ channel → -caine' },
      { title: '抗癲癇藥物', content: 'Partial seizure: Carbamazepine, Phenytoin, Lamotrigine\nGeneralized absence: Ethosuximide (T-type Ca²⁺), Valproic acid\nGeneralized tonic-clonic: Valproic acid, Phenytoin\nStatus epilepticus: IV Benzodiazepine → Phenytoin\nValproic acid: 廣效但→肝毒性、NTD、PCOS\nPhenytoin: Na⁺ channel blocker → 牙齦增生、SJS\nCarbamazepine: 需查 HLA-B*1502(亞洲人→SJS)' },
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
    id: 'pathology', icon: '🔬', name: '病理學', color: '#EC4899',
    cards: [
      { title: '細胞損傷與壞死', content: 'Reversible: 細胞腫脹、脂肪變性\nIrreversible: 膜破裂、粒線體功能喪失\n壞死類型：\nCoagulative: 心肌梗塞(最常見)\nLiquefactive: 腦梗塞、膿瘍\nCaseous: 結核(乾酪樣)\nFat: 急性胰臟炎(皂化)\nFibrinoid: 血管炎\nGangrenous: 肢端(乾性)、腸(濕性)\nApoptosis: 程式性死亡、caspase、無發炎' },
      { title: '腫瘤標記', content: 'AFP: 肝細胞癌、卵黃囊瘤\nCEA: 大腸癌(追蹤用)\nCA-125: 卵巢癌\nCA 19-9: 胰臟癌\nPSA: 攝護腺癌\nHCG: 絨毛膜癌、睪丸癌\nS-100: 黑色素瘤、神經腫瘤\nDesmin: 肌肉來源腫瘤\nVimentin: 間質來源(sarcoma)\nCytokeratin: 上皮來源(carcinoma)' },
      { title: '發炎反應', content: '急性發炎：neutrophil 主導\n血管變化：血管擴張→血流增加→紅腫熱\n化學趨化因子：C5a, IL-8, LTB4\n慢性發炎：macrophage + lymphocyte 主導\n肉芽腫(Granuloma)：\nCaseating: TB, fungal\nNon-caseating: Sarcoidosis, Crohn\'s\n發炎介質：\nHistamine→血管通透性↑\nPGE2→發燒、疼痛\nLTC4/D4/E4→支氣管收縮' },
      { title: '血液病理', content: '缺鐵性貧血：MCV↓, ferritin↓, TIBC↑, Fe↓\n巨母紅血球貧血：MCV↑, B12或folate↓\n鐮刀型貧血：HbS, Glu→Val at β-6\n地中海貧血：α(--/--刪除) or β(突變)→Hb電泳\nG6PD 缺乏：X-linked, Heinz bodies, bite cells\n溶血: ↑indirect bilirubin, ↑reticulocyte, ↑LDH, ↓haptoglobin\nDIC: ↑PT/APTT, ↓fibrinogen, ↑D-dimer, schistocytes' },
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
    id: 'parasitology', icon: '🪱', name: '寄生蟲學', color: '#14B8A6',
    cards: [
      { title: '瘧疾 Malaria', content: 'Plasmodium 四種(+knowlesi):\nP. falciparum: 最嚴重、腦瘧疾、banana-shaped gametocyte\nP. vivax/ovale: hypnozoite(肝休眠體)→復發，需 primaquine\nP. malariae: 每72hr(quartan)\n傳播：Anopheles 蚊\n診斷：厚/薄血片、快篩\n治療：Chloroquine (非 falciparum)、ACT (falciparum)\nG6PD 需檢查再給 Primaquine' },
      { title: '腸道寄生蟲速記', content: 'Ascaris(蛔蟲): 最大腸道線蟲、Loeffler syndrome(肺)\nEnterobius(蟯蟲): 肛門搔癢、scotch tape test\nAncylostoma/Necator(鉤蟲): 缺鐵性貧血、barefoot\nStrongyloides: autoinfection → 免疫低下者致命\nTrichuris(鞭蟲): barrel-shaped eggs、直腸脫垂\nTaenia: solium(豬)→囊尾蟲症(腦)、saginata(牛)\nEntamoeba histolytica: 痢疾、肝膿瘍(anchovy paste)' },
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
    id: 'public_health', icon: '🏥', name: '公共衛生', color: '#84CC16',
    cards: [
      { title: '流行病學研究設計', content: '觀察性：\nCase-control: 回溯、快速、適合罕見疾病 → OR\nCohort: 前瞻/回溯、追蹤暴露組 → RR\nCross-sectional: 某時間點的 prevalence\nEcological: 群體層級(ecological fallacy)\n\n介入性：\nRCT: gold standard、需 blinding + randomization\n\n因果關係: Bradford Hill criteria\n偏差: Selection, Information(recall), Confounding' },
      { title: '生物統計', content: 'Sensitivity: TP/(TP+FN) → 排除疾病(SnNout)\nSpecificity: TN/(TN+FP) → 確認疾病(SpPin)\nPPV: TP/(TP+FP)，受盛行率影響\nNPV: TN/(TN+FN)\n\nType I error (α): 偽陽性(reject true H₀)\nType II error (β): 偽陰性(accept false H₀)\nPower = 1 - β\n\np < 0.05: 統計顯著\nCI 不包含 null value(RR=1, OR=1): 顯著' },
      { title: '預防醫學層級', content: '初段預防 (Primary): 防止疾病發生\n→ 疫苗接種、衛教、安全帶\n\n次段預防 (Secondary): 早期發現早期治療\n→ 篩檢(mammography, Pap smear, colonoscopy)\n\n三段預防 (Tertiary): 減少殘障、復健\n→ 物理治療、支持團體\n\n篩檢條件：疾病嚴重、有潛伏期、\n有可行的檢測方法、早期治療有效' },
    ]
  },
]

function NoteCard({ card, index }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <button onClick={() => setExpanded(!expanded)}
      className="w-full text-left bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden transition-all active:scale-[0.98]">
      <div className="px-4 py-3 flex items-center gap-3">
        <span className="w-7 h-7 rounded-lg bg-medical-ice text-medical-blue text-xs font-bold flex items-center justify-center shrink-0">
          {index + 1}
        </span>
        <p className="font-bold text-sm text-medical-dark flex-1">{card.title}</p>
        <span className={`text-gray-300 text-lg transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
      </div>
      {expanded && (
        <div className="px-4 pb-4 pt-0">
          <div className="bg-medical-ice rounded-xl px-4 py-3">
            <pre className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap font-[inherit]">{card.content}</pre>
          </div>
        </div>
      )}
    </button>
  )
}

export default function Notes() {
  const navigate = useNavigate()
  const [selectedSubject, setSelectedSubject] = useState(null)

  if (selectedSubject) {
    const subj = SUBJECTS.find(s => s.id === selectedSubject)
    return (
      <div className="flex flex-col min-h-dvh bg-medical-ice">
        <div className="sticky top-0 z-10 px-4 pt-12 pb-4 grad-header">
          <div className="flex items-center gap-3">
            <button onClick={() => setSelectedSubject(null)} className="text-white/60 text-2xl leading-none">‹</button>
            <div className="flex-1">
              <h1 className="text-white font-bold text-xl">{subj.icon} {subj.name}</h1>
              <p className="text-white/50 text-xs">{subj.cards.length} 張精華卡</p>
            </div>
            <button onClick={() => navigate(`/practice`)}
              className="bg-white/15 text-white text-xs font-bold px-3 py-1.5 rounded-xl active:scale-95">
              去練習 →
            </button>
          </div>
        </div>

        <div className="flex-1 px-4 py-4 flex flex-col gap-2.5">
          {subj.cards.map((card, i) => (
            <NoteCard key={i} card={card} index={i} />
          ))}

          <div className="bg-amber-50 rounded-2xl p-4 border border-amber-200 mt-2">
            <p className="text-amber-800 font-bold text-sm">💡 學習建議</p>
            <p className="text-amber-700 text-xs mt-1 leading-relaxed">
              先看完精華卡建立整體架構，再去「自主練習」用題目驗證理解。答錯的題目會自動加入錯題本，之後間隔複習效果更好。
            </p>
          </div>
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
            <p className="text-white/50 text-xs">10 大科目高頻考點速記</p>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-2.5">
        {SUBJECTS.map(subj => (
          <button key={subj.id} onClick={() => setSelectedSubject(subj.id)}
            className="w-full text-left bg-white rounded-2xl px-5 py-4 border border-gray-100 shadow-sm transition-all active:scale-[0.97]">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
                   style={{ backgroundColor: subj.color + '15' }}>
                {subj.icon}
              </div>
              <div className="flex-1">
                <p className="font-bold text-base text-medical-dark">{subj.name}</p>
                <p className="text-gray-400 text-xs mt-0.5">{subj.cards.length} 張精華卡 · {subj.cards.map(c => c.title).slice(0, 2).join('、')}…</p>
              </div>
              <span className="text-gray-300 text-xl">›</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
