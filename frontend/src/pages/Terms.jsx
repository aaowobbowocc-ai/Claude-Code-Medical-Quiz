import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'
import { usePageMeta } from '../hooks/usePageMeta'

export default function Terms() {
  const navigate = useNavigate()
  usePageMeta('服務條款', '國考知識王服務條款：題庫來源（考選部）、使用規範、免責聲明。')

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-5 pt-14 pb-6">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">服務條款</h1>
        <p className="text-white/50 text-sm text-center mt-1">Terms of Service</p>
      </div>

      <div className="flex-1 px-5 py-6">
        <div className="bg-white rounded-2xl shadow-sm p-6 text-sm text-gray-700 leading-relaxed space-y-5">
          <p className="text-xs text-gray-400">最後更新日期：2026 年 5 月 27 日</p>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">一、服務說明</h2>
            <p>
              「國考知識王」（以下簡稱「本平台」）是一個國家考試題庫練習平台，涵蓋醫事人員（醫師、牙醫師、藥師、護理師、中醫師、獸醫師、醫事檢驗師、物理治療師、職能治療師、醫事放射師、營養師、社會工作師、呼吸治療師、聽力師、語言治療師、心理師、驗光人員等）、律師一試與司法特考、公職（高考三等、普考、初考、關務、警察、一般警察等）、教師資格考試、國營事業聯招、中華郵政與台鐵招考、學科能力測驗與分科測驗、汽機車駕照筆試，合計 52 個考試，收錄 100–115 年約 230,000 題考古題，
              提供即時對戰、自主練習、模擬考試、AI 解說等功能，旨在協助考生備考各類國家考試。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">二、題庫來源與聲明</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>本平台所使用之題目均為各主管機關<strong>公開發布</strong>的歷屆試題（100–115 年度），來源包括：中華民國<strong>考選部</strong>（醫事、法律、公職、國營與郵政等專技與公務人員考試）、<strong>大學入學考試中心</strong>（學科能力測驗、分科測驗）、<strong>教育部</strong>（教師資格考試）、<strong>台灣電力公司</strong>（經濟部國營事業聯合招考）、<strong>交通部公路局</strong>（汽機車駕照筆試題庫）。</li>
              <li>依《著作權法》第 9 條規定，依法令舉行之各類考試試題不得為著作權之標的；上述試題並屬政府公開資訊，本平台提供練習使用。</li>
              <li>題目之 AI 解說由 Google Vertex AI Gemini 人工智慧生成，僅供參考，不代表官方標準答案或醫學專業意見。</li>
              <li>若您發現題目或答案有誤，歡迎透過意見回饋功能回報，我們會盡速修正。</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">三、使用規範</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>本平台僅供個人學習與練習使用，不得用於商業用途。</li>
              <li>使用者不得利用技術手段干擾平台正常運作、竄改排行榜資料，或進行任何惡意行為。</li>
              <li>使用者在對戰房間中應保持基本禮儀，不得使用不當暱稱或騷擾其他使用者。</li>
              <li>使用者不得大量自動化爬取本平台的題目內容。</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">四、免責聲明</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>本平台提供的所有內容僅供練習參考，不保證題目、答案或 AI 解說的完全正確性。</li>
              <li>本平台不對使用者的考試結果承擔任何責任。</li>
              <li>本平台的題庫與練習功能免費提供，不保證服務的持續性、穩定性或即時性，可能因維護或不可抗力因素而暫停服務。</li>
              <li>本平台內的「金幣」為虛擬遊戲積分，無任何現實貨幣價值（詳見第八條）。</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">五、智慧財產權</h2>
            <p>
              本平台的介面設計、程式碼、遊戲機制等屬開發者所有。歷屆試題的內容屬各原出題機關（考選部、大學入學考試中心、教育部、台灣電力公司、交通部公路局）公開發布之資料。
              使用者不得未經授權複製、散布或修改本平台之內容。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">六、帳號與資料</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>本平台不需要註冊帳號，您的遊戲資料儲存在瀏覽器本機。</li>
              <li>清除瀏覽器資料可能導致遊戲進度遺失，本平台不對此負責。</li>
              <li>排行榜資料可能會因系統維護而定期重置。</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">七、廣告</h2>
            <p>
              本平台透過 Google AdSense（網頁版）與 Google AdMob（Android App 版）展示廣告以維持免費營運。
              廣告內容由 Google 根據使用者興趣自動投放，不代表本平台立場或推薦。
              Android App 版主要使用「獎勵影片廣告」：使用者可選擇是否觀看廣告以獲得遊戲金幣，純自願性質。
              如需了解更多，請參閱我們的<a href="/privacy" className="text-medical-blue underline">隱私權政策</a>。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">八、金幣與付費項目</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>題庫、練習、模擬考、對戰等<strong>核心功能一律免費</strong>，不需要付費也不需要註冊帳號即可使用。</li>
              <li>「金幣」為平台內的虛擬點數，可透過每日簽到、觀看獎勵廣告、升等、邀請朋友等方式免費取得。</li>
              <li>App 版另提供金幣的<strong>App 內購買</strong>（由 Apple App Store 或 Google Play 處理付款），網頁版提供街口支付。購買純屬自願，不影響任何核心功能的使用。</li>
              <li>金幣無現實貨幣價值，不可兌換現金、轉讓或退還。已完成的購買依各平台（Apple／Google／街口支付）的退款政策處理。</li>
              <li>本平台不提供訂閱制服務。</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">九、條款變更</h2>
            <p>
              本平台保留隨時修改服務條款的權利。變更後的版本將公布於本頁面。
              繼續使用本平台即表示您同意更新後的條款。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">十、聯絡方式</h2>
            <p>
              如您對本服務條款有任何疑問，歡迎透過平台內的意見回饋功能與我們聯繫（aaowobbowocc@gmail.com）。
            </p>
          </section>
        </div>
      </div>

      <Footer />
    </div>
  )
}
