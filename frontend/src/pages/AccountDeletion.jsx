/**
 * Account Deletion Instructions — Play Store / Apple 政策要求的公開頁面。
 *
 * Play Console「資料安全性」問卷指定的「刪除帳戶網址」必須符合：
 *  1. 提及應用程式/開發者名稱
 *  2. 顯眼處列出步驟
 *  3. 指明刪除/保留的資料類型與額外保留期限
 *
 * 對應後端 endpoint：POST /api/account/delete (見 backend/account.js)
 * 對應 App 內入口：首頁 → 右上頭像 → 編輯名字 → 帳號綁定區下方「刪除帳號」
 */
import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'
import { usePageMeta } from '../hooks/usePageMeta'

export default function AccountDeletion() {
  const navigate = useNavigate()
  usePageMeta('刪除帳號與資料', '國考知識王帳號與個人資料刪除說明：刪除流程、資料保留期限與聯絡方式。')

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-5 pt-14 pb-6 relative">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">刪除帳號與資料</h1>
        <p className="text-white/50 text-sm text-center mt-1">Account & Data Deletion</p>
      </div>

      <div className="flex-1 px-5 py-6">
        <div className="bg-white rounded-2xl shadow-sm p-6 text-sm text-gray-700 leading-relaxed space-y-5">
          <p className="text-xs text-gray-400">最後更新日期：2026 年 6 月 1 日</p>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">適用對象</h2>
            <p>
              本說明適用於「<strong>國考知識王</strong>」（examking.tw）所有版本，
              包含網頁版（examking.tw）、Android App（Google Play 上架）、iOS App。
              開發者：國考知識王開發團隊（aaowobbowocc@gmail.com）。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">一、自助刪除步驟（建議）</h2>
            <p className="mb-2">您可在 App 內自助完成帳號刪除，作業即時生效：</p>
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>登入您的帳號（必須已綁定 Google 才能刪除）</li>
              <li>於首頁右上角點按您的<strong>頭像</strong> → 進入「編輯名字」</li>
              <li>滑到頁面最下方的「帳號綁定」區塊</li>
              <li>點按下方灰色小字「<strong>刪除帳號</strong>」連結</li>
              <li>於彈出視窗中輸入「<strong>刪除</strong>」二字確認</li>
              <li>點按「永久刪除」按鈕，系統會立即處理並登出</li>
            </ol>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">二、客服協助刪除（替代方案）</h2>
            <p>若您無法登入或不便操作 App，可透過下列方式來信申請刪除：</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li>Email：<a href="mailto:aaowobbowocc@gmail.com" className="text-medical-blue underline">aaowobbowocc@gmail.com</a></li>
              <li>主旨請註明：「申請刪除國考知識王帳號」</li>
              <li>內文請提供：您註冊使用的 <strong>Google 帳號 Email</strong>（用於確認身分）</li>
              <li>處理時間：收到信件後 <strong>7 個工作天內</strong>完成刪除並回信確認</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">三、會被刪除的資料</h2>
            <p className="mb-2">執行刪除後，下列個人資料將<strong>立即從伺服器永久移除</strong>：</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>帳號識別資料（Google 帳號連結、user_id）</li>
              <li>個人資料（暱稱、頭像、等級、金幣餘額）</li>
              <li>已購買/解鎖的頭像、邊框、徽章</li>
              <li>AI 解說無限包訂閱狀態與購買紀錄</li>
              <li>付費解鎖的單題 AI 解說紀錄</li>
              <li>已領取的 changelog 獎勵紀錄</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">四、會被「匿名保留」的資料</h2>
            <p className="mb-2">
              下列資料因屬<strong>公共記錄或營運合規需要</strong>，會將其中的帳號識別欄位
              （user_id）設為 NULL，但保留紀錄內容：
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>排行榜分數、模擬考成績</strong>：保留分數但拔除帳號連結（暱稱會變為「已刪除使用者」）</li>
              <li><strong>金流訂單（街口/綠界）</strong>：依稅務法規須保留 5 年，但拔除帳號連結</li>
              <li><strong>感謝榜贊助記錄</strong>：保留贊助記錄與金額，但拔除帳號連結</li>
              <li><strong>站內回饋、題目錯誤回報</strong>：保留問題內容供後續處理，但拔除帳號連結</li>
              <li><strong>過時法條回報</strong>：保留貢獻內容供社群參考，但拔除帳號連結</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">五、額外保留期限</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>金流訂單紀錄</strong>：依台灣《商業會計法》第 38 條，自交易日起保留 5 年（不含個人身分識別資料）</li>
              <li><strong>系統日誌與備份檔</strong>：最長保留 30 天，過期後自動清除</li>
              <li><strong>Google Analytics 匿名統計</strong>：依 Google 預設保留 14 個月</li>
              <li><strong>AdMob 廣告 ID</strong>：屬 Google 持有，請至 Android 系統設定「廣告」中重設或刪除</li>
            </ul>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">六、刪除後復原</h2>
            <p>
              帳號刪除為<strong>不可逆操作</strong>，刪除完成後資料無法復原。
              若您日後重新使用相同 Google 帳號登入，系統會將其視為全新帳號，過去的金幣、頭像、徽章、解鎖紀錄等皆無法恢復。
            </p>
          </section>

          <section>
            <h2 className="font-bold text-base text-medical-dark mb-2">七、聯絡方式</h2>
            <p>
              如對本說明或刪除流程有任何疑問，請來信：<br />
              📧 <a href="mailto:aaowobbowocc@gmail.com" className="text-medical-blue underline">aaowobbowocc@gmail.com</a>
            </p>
            <p className="text-xs text-gray-500 mt-2">
              相關政策：
              <button onClick={() => navigate('/privacy')} className="text-medical-blue underline ml-1">隱私權政策</button>
              ・
              <button onClick={() => navigate('/tos')} className="text-medical-blue underline ml-1">服務條款</button>
              ・
              <button onClick={() => navigate('/contact')} className="text-medical-blue underline ml-1">聯絡我們</button>
            </p>
          </section>
        </div>
      </div>

      <Footer />
    </div>
  )
}
