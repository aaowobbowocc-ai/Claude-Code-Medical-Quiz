import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'
import { usePageMeta } from '../hooks/usePageMeta'

export default function Privacy() {
  const navigate = useNavigate()
  usePageMeta('隱私權政策', '醫學知識王隱私權政策：Cookie 使用、Google 廣告、資料蒐集與保護說明。')

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-5 pt-14 pb-6">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">隱私權政策</h1>
        <p className="text-white/50 text-sm text-center mt-1">Privacy Policy</p>
      </div>

      <div className="flex-1 px-5 py-6">
        <div className="bg-white rounded-2xl shadow-sm p-6 text-sm text-gray-700 leading-relaxed space-y-5">
          <p className="text-xs text-gray-400">最後更新日期：2025 年 4 月</p>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">一、總則</h2>
            <p>
              「醫學知識王」（以下簡稱「本平台」）為一免費醫師國考第一階段題庫練習平台，致力於保護使用者的隱私權。
              本政策說明我們如何蒐集、使用與保護您的個人資訊。使用本平台即表示您同意本隱私權政策的內容。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">二、我們蒐集的資訊</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>暱稱與頭像：</strong>您在註冊時自行設定的暱稱與頭像，用於遊戲內顯示。</li>
              <li><strong>遊戲紀錄：</strong>對戰結果、練習紀錄、模擬考成績等，儲存於您的瀏覽器本機（localStorage）。</li>
              <li><strong>排行榜資料：</strong>您的暱稱與答題成績可能顯示在公開排行榜上。</li>
              <li><strong>使用分析：</strong>我們使用 Google Analytics 蒐集匿名的使用統計資料（如頁面瀏覽量、裝置類型），以改善使用體驗。</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">三、Cookie 與廣告技術</h2>
            <p>本平台使用以下技術：</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li><strong>Google AdSense：</strong>我們透過 Google AdSense 展示廣告。Google 可能會使用 Cookie 根據您先前造訪本網站或其他網站的記錄，向您放送合適的廣告。</li>
              <li><strong>Google Analytics：</strong>用於分析網站流量與使用行為，所蒐集的資料皆為匿名且無法識別個人身分。</li>
              <li><strong>必要 Cookie：</strong>用於維持您的遊戲狀態與偏好設定（如深色模式、暱稱）。</li>
            </ul>
            <p className="mt-2">
              您可以透過瀏覽器設定管理或停用 Cookie。如需了解 Google 如何使用廣告 Cookie，請參閱
              <a href="https://policies.google.com/technologies/ads" target="_blank" rel="noopener noreferrer" className="text-medical-blue underline ml-1">Google 廣告隱私權政策</a>。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">四、資料的使用方式</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>提供並維護平台功能（對戰、練習、排行榜等）</li>
              <li>改善使用者體驗與平台效能</li>
              <li>展示相關廣告以維持平台免費營運</li>
              <li>統計分析使用趨勢</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">五、資料的儲存與保護</h2>
            <p>
              您的遊戲紀錄主要儲存在您的瀏覽器本機（localStorage），我們的伺服器僅儲存排行榜所需的最少資訊（暱稱與成績）。
              我們採取合理的技術措施來保護傳輸中的資料安全。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">六、第三方服務</h2>
            <p>本平台使用以下第三方服務，各服務有其隱私權政策：</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li>Google AdSense（廣告）</li>
              <li>Google Analytics（流量分析）</li>
              <li>Vercel（網站託管）</li>
              <li>Render（後端伺服器託管）</li>
              <li>OpenAI API（AI 題目解說功能）</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">七、兒童隱私</h2>
            <p>
              本平台主要面向醫學系學生與醫師國考考生。我們不會刻意蒐集 13 歲以下兒童的個人資訊。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">八、政策變更</h2>
            <p>
              我們可能會不定期更新本隱私權政策。變更後的版本將公布於本頁面，並更新「最後更新日期」。
              繼續使用本平台即表示您同意更新後的政策。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">九、聯絡我們</h2>
            <p>
              如您對本隱私權政策有任何疑問，歡迎透過意見回饋功能或來信至開發者信箱與我們聯繫。
            </p>
          </section>
        </div>
      </div>

      <Footer />
    </div>
  )
}
