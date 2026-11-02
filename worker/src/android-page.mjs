/**
 * android-page.mjs — the Android download portal's HTML (served by the Worker
 * at /android). Pure function, no imports, so it can be previewed in Node.
 *
 * Mobile-first: designed for a phone held upright; fine on desktop too.
 * Text is in the game's eight languages (same wording as the launcher).
 * The page fetches /android/api/state and renders client-side.
 */

export const LANGS = [
  { code: "en", name: "English", locale: "en-GB" },
  { code: "de", name: "Deutsch", locale: "de-DE" },
  { code: "es", name: "Español", locale: "es-419" },
  { code: "pt-br", name: "Português (Brasil)", locale: "pt-BR" },
  { code: "ru", name: "Русский", locale: "ru-RU" },
  { code: "ja", name: "日本語", locale: "ja-JP" },
  { code: "zh-tw", name: "繁體中文", locale: "zh-TW" },
  { code: "zh-cn", name: "简体中文", locale: "zh-CN" },
];

const S = {
  en: {
    title: "Android downloads",
    intro: "Sign in with the account you support {studio} with. You'll sign in on their site — we never see your password.",
    patreon: "Continue with Patreon",
    substar: "Continue with SubscribeStar",
    haveCode: "Have a code?",
    codeGo: "Continue",
    signOut: "Sign out",
    tier: "Tier {n}",
    download: "Download v{version}",
    downloading: "Your download should start in a moment…",
    size: "{size} · APK",
    latestForYou: "Latest for your tier",
    pending: "**v{version}** is out now for {dayOne}. On **{tier}** ({day}) it unlocks for you on **{date}**.",
    pendingUpgrade: "Or upgrade to get it today.",
    locked: "This game needs the **{tier}** tier. You're currently on **{current}**.",
    upgrade: "Upgrade",
    resubscribe: "Re-subscribe",
    recheck: "Just upgraded? Re-check",
    noAndroid: "No Android build has been published yet.",
    older: "Older versions",
    notes: "What's new",
    howtoTitle: "Installing on Android",
    howto1: "Tap Download and let it finish — it's a large file, so Wi‑Fi is a good idea.",
    howto2: "Open the downloaded .apk from your notifications or the Files app.",
    howto3: "If Android asks, allow your browser to install unknown apps, then tap Install.",
    howto4: "Installing a new version over the old one keeps your saves.",
    age: "I am **18 years of age or over** (or the age of majority where I live, if higher), and I accept the [eula]End User Licence Agreement[/eula] and the [privacy]Privacy Policy[/privacy].",
    eula: "End User Licence Agreement",
    privacy: "Privacy Policy",
    desktop: "On a computer? [launcher]Get the launcher[/launcher] instead.",
    loading: "Loading…",
    error: "Something went wrong: {message}",
    codeInvalid: "That code isn't valid.",
    loginFailed: "Sign-in didn't complete. Please try again.",
    dayOne: "Day 1 release",
    dayN: "Day {n} release",
    aDayOneTier: "a Day 1 tier",
    yourTier: "your tier",
    adultNote: "Adults only.",
  },
  de: {
    title: "Android-Downloads",
    intro: "Melde dich mit dem Konto an, mit dem du {studio} unterstützt. Du meldest dich auf deren Seite an — dein Passwort sehen wir nie.",
    patreon: "Weiter mit Patreon",
    substar: "Weiter mit SubscribeStar",
    haveCode: "Hast du einen Code?",
    codeGo: "Weiter",
    signOut: "Abmelden",
    tier: "Stufe {n}",
    download: "v{version} herunterladen",
    downloading: "Dein Download sollte gleich starten…",
    size: "{size} · APK",
    latestForYou: "Aktuell für deine Stufe",
    pending: "**v{version}** ist jetzt für {dayOne} verfügbar. Auf **{tier}** ({day}) wird sie für dich am **{date}** freigeschaltet.",
    pendingUpgrade: "Oder upgrade, um sie heute zu bekommen.",
    locked: "Dieses Spiel benötigt die Stufe **{tier}**. Du bist derzeit auf **{current}**.",
    upgrade: "Upgraden",
    resubscribe: "Erneut abonnieren",
    recheck: "Gerade upgegradet? Erneut prüfen",
    noAndroid: "Es wurde noch keine Android-Version veröffentlicht.",
    older: "Ältere Versionen",
    notes: "Neuigkeiten",
    howtoTitle: "Installation unter Android",
    howto1: "Tippe auf Herunterladen und warte, bis es fertig ist — die Datei ist groß, WLAN ist eine gute Idee.",
    howto2: "Öffne die heruntergeladene .apk über die Benachrichtigungen oder die Dateien-App.",
    howto3: "Wenn Android fragt, erlaube deinem Browser die Installation unbekannter Apps, und tippe dann auf Installieren.",
    howto4: "Wenn du eine neue Version über die alte installierst, bleiben deine Spielstände erhalten.",
    age: "Ich bin **mindestens 18 Jahre alt** (bzw. volljährig nach dem Recht meines Wohnorts, falls das Alter höher liegt) und akzeptiere die [eula]Endbenutzer-Lizenzvereinbarung[/eula] und die [privacy]Datenschutzerklärung[/privacy].",
    eula: "Endbenutzer-Lizenzvereinbarung",
    privacy: "Datenschutzerklärung",
    desktop: "Am Computer? [launcher]Hol dir stattdessen den Launcher[/launcher].",
    loading: "Wird geladen…",
    error: "Etwas ist schiefgelaufen: {message}",
    codeInvalid: "Dieser Code ist ungültig.",
    loginFailed: "Die Anmeldung wurde nicht abgeschlossen. Bitte versuche es erneut.",
    dayOne: "Veröffentlichung Tag 1",
    dayN: "Veröffentlichung Tag {n}",
    aDayOneTier: "eine Tag-1-Stufe",
    yourTier: "deine Stufe",
    adultNote: "Nur für Erwachsene.",
  },
  es: {
    title: "Descargas para Android",
    intro: "Inicia sesión con la cuenta con la que apoyas a {studio}. Iniciarás sesión en su sitio: nunca vemos tu contraseña.",
    patreon: "Continuar con Patreon",
    substar: "Continuar con SubscribeStar",
    haveCode: "¿Tienes un código?",
    codeGo: "Continuar",
    signOut: "Cerrar sesión",
    tier: "Nivel {n}",
    download: "Descargar v{version}",
    downloading: "Tu descarga debería empezar en un momento…",
    size: "{size} · APK",
    latestForYou: "Última para tu nivel",
    pending: "**v{version}** ya está disponible para {dayOne}. En **{tier}** ({day}) se desbloqueará para ti el **{date}**.",
    pendingUpgrade: "O sube de nivel para obtenerla hoy.",
    locked: "Este juego requiere el nivel **{tier}**. Actualmente estás en **{current}**.",
    upgrade: "Subir de nivel",
    resubscribe: "Volver a suscribirse",
    recheck: "¿Acabas de subir de nivel? Volver a comprobar",
    noAndroid: "Todavía no se ha publicado ninguna versión para Android.",
    older: "Versiones anteriores",
    notes: "Novedades",
    howtoTitle: "Instalación en Android",
    howto1: "Toca Descargar y espera a que termine: es un archivo grande, así que conviene usar Wi‑Fi.",
    howto2: "Abre el .apk descargado desde las notificaciones o la app Archivos.",
    howto3: "Si Android lo pide, permite que tu navegador instale apps desconocidas y luego toca Instalar.",
    howto4: "Instalar una versión nueva sobre la anterior conserva tus partidas guardadas.",
    age: "Tengo **18 años o más** (o la mayoría de edad donde vivo, si es mayor) y acepto el [eula]Acuerdo de licencia de usuario final[/eula] y la [privacy]Política de privacidad[/privacy].",
    eula: "Acuerdo de licencia de usuario final",
    privacy: "Política de privacidad",
    desktop: "¿Estás en una computadora? [launcher]Descarga el launcher[/launcher].",
    loading: "Cargando…",
    error: "Algo salió mal: {message}",
    codeInvalid: "Ese código no es válido.",
    loginFailed: "No se completó el inicio de sesión. Inténtalo de nuevo.",
    dayOne: "Lanzamiento día 1",
    dayN: "Lanzamiento día {n}",
    aDayOneTier: "un nivel de día 1",
    yourTier: "tu nivel",
    adultNote: "Solo para adultos.",
  },
  "pt-br": {
    title: "Downloads para Android",
    intro: "Entre com a conta que você usa para apoiar a {studio}. Você vai entrar no site deles — nunca vemos sua senha.",
    patreon: "Continuar com Patreon",
    substar: "Continuar com SubscribeStar",
    haveCode: "Tem um código?",
    codeGo: "Continuar",
    signOut: "Sair",
    tier: "Nível {n}",
    download: "Baixar v{version}",
    downloading: "Seu download deve começar em instantes…",
    size: "{size} · APK",
    latestForYou: "Mais recente para o seu nível",
    pending: "**v{version}** já saiu para {dayOne}. No **{tier}** ({day}) ela será desbloqueada para você em **{date}**.",
    pendingUpgrade: "Ou suba de nível para baixar hoje.",
    locked: "Este jogo requer o nível **{tier}**. Você está atualmente em **{current}**.",
    upgrade: "Subir de nível",
    resubscribe: "Assinar de novo",
    recheck: "Acabou de subir de nível? Verificar novamente",
    noAndroid: "Nenhuma versão para Android foi publicada ainda.",
    older: "Versões anteriores",
    notes: "Novidades",
    howtoTitle: "Instalando no Android",
    howto1: "Toque em Baixar e espere terminar — é um arquivo grande, então é bom usar Wi‑Fi.",
    howto2: "Abra o .apk baixado pelas notificações ou pelo app Arquivos.",
    howto3: "Se o Android perguntar, permita que o navegador instale apps desconhecidos e depois toque em Instalar.",
    howto4: "Instalar uma versão nova por cima da antiga mantém seus saves.",
    age: "Tenho **18 anos ou mais** (ou a maioridade legal onde moro, se for maior) e aceito o [eula]Contrato de Licença de Usuário Final[/eula] e a [privacy]Política de Privacidade[/privacy].",
    eula: "Contrato de Licença de Usuário Final",
    privacy: "Política de Privacidade",
    desktop: "Está no computador? [launcher]Baixe o launcher[/launcher].",
    loading: "Carregando…",
    error: "Algo deu errado: {message}",
    codeInvalid: "Esse código não é válido.",
    loginFailed: "O login não foi concluído. Tente de novo.",
    dayOne: "Lançamento dia 1",
    dayN: "Lançamento dia {n}",
    aDayOneTier: "um nível de dia 1",
    yourTier: "seu nível",
    adultNote: "Somente para adultos.",
  },
  ru: {
    title: "Загрузки для Android",
    intro: "Войдите с аккаунтом, через который вы поддерживаете {studio}. Вы войдёте на их сайте — мы никогда не видим ваш пароль.",
    patreon: "Продолжить через Patreon",
    substar: "Продолжить через SubscribeStar",
    haveCode: "Есть код?",
    codeGo: "Продолжить",
    signOut: "Выйти",
    tier: "Уровень {n}",
    download: "Скачать v{version}",
    downloading: "Загрузка должна начаться через мгновение…",
    size: "{size} · APK",
    latestForYou: "Последняя для вашего уровня",
    pending: "**v{version}** уже вышла для {dayOne}. На уровне **{tier}** ({day}) она откроется для вас **{date}**.",
    pendingUpgrade: "Или повысьте уровень, чтобы получить её сегодня.",
    locked: "Для этой игры нужен уровень **{tier}**. Сейчас у вас **{current}**.",
    upgrade: "Повысить уровень",
    resubscribe: "Подписаться снова",
    recheck: "Только что повысили уровень? Проверить снова",
    noAndroid: "Версия для Android ещё не опубликована.",
    older: "Старые версии",
    notes: "Что нового",
    howtoTitle: "Установка на Android",
    howto1: "Нажмите «Скачать» и дождитесь окончания — файл большой, лучше по Wi‑Fi.",
    howto2: "Откройте скачанный .apk из уведомлений или приложения «Файлы».",
    howto3: "Если Android спросит, разрешите браузеру установку неизвестных приложений и нажмите «Установить».",
    howto4: "Установка новой версии поверх старой сохраняет ваши сохранения.",
    age: "Мне **18 лет или больше** (либо я достиг совершеннолетия по законам места проживания, если этот возраст выше), и я принимаю [eula]Лицензионное соглашение[/eula] и [privacy]Политику конфиденциальности[/privacy].",
    eula: "Лицензионное соглашение",
    privacy: "Политика конфиденциальности",
    desktop: "Вы за компьютером? [launcher]Скачайте лаунчер[/launcher].",
    loading: "Загрузка…",
    error: "Что-то пошло не так: {message}",
    codeInvalid: "Этот код недействителен.",
    loginFailed: "Вход не завершён. Попробуйте ещё раз.",
    dayOne: "Релиз: день 1",
    dayN: "Релиз: день {n}",
    aDayOneTier: "уровней дня 1",
    yourTier: "ваш уровень",
    adultNote: "Только для взрослых.",
  },
  ja: {
    title: "Android 版ダウンロード",
    intro: "{studio} を支援しているアカウントでサインインしてください。サインインは各サイト上で行われ、パスワードが私たちに見えることはありません。",
    patreon: "Patreon で続行",
    substar: "SubscribeStar で続行",
    haveCode: "コードをお持ちですか？",
    codeGo: "続行",
    signOut: "サインアウト",
    tier: "ティア {n}",
    download: "v{version} をダウンロード",
    downloading: "まもなくダウンロードが始まります…",
    size: "{size} · APK",
    latestForYou: "あなたのティアの最新版",
    pending: "**v{version}** は {dayOne} 向けに公開中です。**{tier}**（{day}）では **{date}** に解除されます。",
    pendingUpgrade: "今すぐ入手するにはアップグレードしてください。",
    locked: "このゲームには **{tier}** ティアが必要です。現在のティアは **{current}** です。",
    upgrade: "アップグレード",
    resubscribe: "再登録",
    recheck: "アップグレードしたばかりですか？再確認",
    noAndroid: "Android 版はまだ公開されていません。",
    older: "以前のバージョン",
    notes: "最新情報",
    howtoTitle: "Android へのインストール",
    howto1: "「ダウンロード」をタップして完了まで待ちます。大きなファイルなので Wi‑Fi をおすすめします。",
    howto2: "通知または「ファイル」アプリからダウンロードした .apk を開きます。",
    howto3: "Android に確認された場合は、ブラウザによる不明なアプリのインストールを許可し、「インストール」をタップします。",
    howto4: "古いバージョンの上に新しいバージョンをインストールしても、セーブデータは残ります。",
    age: "私は**18歳以上**（お住まいの地域の成人年齢がそれより高い場合はその年齢以上）であり、[eula]エンドユーザー使用許諾契約[/eula]と[privacy]プライバシーポリシー[/privacy]に同意します。",
    eula: "エンドユーザー使用許諾契約",
    privacy: "プライバシーポリシー",
    desktop: "パソコンをお使いですか？[launcher]ランチャーをダウンロード[/launcher]してください。",
    loading: "読み込み中…",
    error: "問題が発生しました: {message}",
    codeInvalid: "そのコードは無効です。",
    loginFailed: "サインインが完了しませんでした。もう一度お試しください。",
    dayOne: "1日目リリース",
    dayN: "{n}日目リリース",
    aDayOneTier: "1日目ティア",
    yourTier: "現在のティア",
    adultNote: "成人向け。",
  },
  "zh-tw": {
    title: "Android 下載",
    intro: "請使用你支持 {studio} 的帳號登入。你會在該平台的網站上登入，我們永遠不會看到你的密碼。",
    patreon: "使用 Patreon 繼續",
    substar: "使用 SubscribeStar 繼續",
    haveCode: "有兌換碼嗎？",
    codeGo: "繼續",
    signOut: "登出",
    tier: "等級 {n}",
    download: "下載 v{version}",
    downloading: "下載即將開始…",
    size: "{size} · APK",
    latestForYou: "你的等級可用的最新版本",
    pending: "**v{version}** 已開放給 {dayOne}。在 **{tier}**（{day}）等級下，將於 **{date}** 為你解鎖。",
    pendingUpgrade: "或升級後今天就能取得。",
    locked: "這款遊戲需要 **{tier}** 等級。你目前的等級是 **{current}**。",
    upgrade: "升級",
    resubscribe: "重新訂閱",
    recheck: "剛升級？重新檢查",
    noAndroid: "目前尚未發布 Android 版本。",
    older: "舊版本",
    notes: "最新消息",
    howtoTitle: "在 Android 上安裝",
    howto1: "點選「下載」並等待完成。檔案很大，建議使用 Wi‑Fi。",
    howto2: "從通知或「檔案」App 開啟下載的 .apk。",
    howto3: "如果 Android 詢問，請允許瀏覽器安裝未知的應用程式，然後點選「安裝」。",
    howto4: "在舊版本上直接安裝新版本，存檔會保留。",
    age: "我已**年滿 18 歲**（若居住地的成年年齡更高，則已達該年齡），並接受[eula]最終使用者授權合約[/eula]與[privacy]隱私權政策[/privacy]。",
    eula: "最終使用者授權合約",
    privacy: "隱私權政策",
    desktop: "使用電腦？請改為[launcher]下載啟動器[/launcher]。",
    loading: "載入中…",
    error: "發生問題：{message}",
    codeInvalid: "此兌換碼無效。",
    loginFailed: "登入未完成，請再試一次。",
    dayOne: "第 1 天發布",
    dayN: "第 {n} 天發布",
    aDayOneTier: "第 1 天等級",
    yourTier: "你的等級",
    adultNote: "僅限成人。",
  },
  "zh-cn": {
    title: "Android 下载",
    intro: "请使用你支持 {studio} 的账号登录。你将在该平台的网站上登录，我们绝不会看到你的密码。",
    patreon: "通过 Patreon 继续",
    substar: "通过 SubscribeStar 继续",
    haveCode: "有兑换码？",
    codeGo: "继续",
    signOut: "退出登录",
    tier: "等级 {n}",
    download: "下载 v{version}",
    downloading: "下载即将开始…",
    size: "{size} · APK",
    latestForYou: "你的等级可用的最新版本",
    pending: "**v{version}** 已向 {dayOne} 开放。在 **{tier}**（{day}）等级下，将于 **{date}** 为你解锁。",
    pendingUpgrade: "或升级后今天就能获取。",
    locked: "这款游戏需要 **{tier}** 等级。你当前的等级是 **{current}**。",
    upgrade: "升级",
    resubscribe: "重新订阅",
    recheck: "刚升级？重新检查",
    noAndroid: "目前尚未发布 Android 版本。",
    older: "旧版本",
    notes: "最新动态",
    howtoTitle: "在 Android 上安装",
    howto1: "点击“下载”并等待完成。文件很大，建议使用 Wi‑Fi。",
    howto2: "从通知或“文件”应用打开下载的 .apk。",
    howto3: "如果 Android 询问，请允许浏览器安装未知应用，然后点击“安装”。",
    howto4: "在旧版本上直接安装新版本，存档会保留。",
    age: "我已**年满 18 周岁**（如所在地的成年年龄更高，则已达到该年龄），并接受[eula]最终用户许可协议[/eula]和[privacy]隐私政策[/privacy]。",
    eula: "最终用户许可协议",
    privacy: "隐私政策",
    desktop: "在电脑上？请改为[launcher]下载启动器[/launcher]。",
    loading: "加载中…",
    error: "出了点问题：{message}",
    codeInvalid: "此兑换码无效。",
    loginFailed: "登录未完成，请重试。",
    dayOne: "第 1 天发布",
    dayN: "第 {n} 天发布",
    aDayOneTier: "第 1 天等级",
    yourTier: "你的等级",
    adultNote: "仅限成年人。",
  },
};

export function pickLang(cookieHeader, acceptLanguage, query) {
  const codes = LANGS.map((l) => l.code);
  if (query && codes.includes(query)) return query;
  const c = (cookieHeader || "").match(/(?:^|;\s*)lang=([a-z-]+)/i)?.[1]?.toLowerCase();
  if (c && codes.includes(c)) return c;
  for (const part of (acceptLanguage || "").toLowerCase().split(",")) {
    const tag = part.trim().split(";")[0];
    if (!tag) continue;
    if (tag.startsWith("pt")) return "pt-br";
    if (tag === "zh-tw" || tag === "zh-hk" || tag.startsWith("zh-hant")) return "zh-tw";
    if (tag.startsWith("zh")) return "zh-cn";
    const base = tag.split("-")[0];
    if (codes.includes(base)) return base;
  }
  return "en";
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * @param {object} o
 * @param {string} o.lang       language code
 * @param {object} o.studio     { name, website, logo (URL) }
 * @param {object} o.links      { eula, privacy, launcher, patreonUpgrade, subscribestar }
 * @param {string} o.apiBase    "" (same origin) or absolute
 */
export function androidPage({ lang, studio, links, apiBase = "" }) {
  const L = LANGS.find((l) => l.code === lang) || LANGS[0];
  const dict = { ...S.en, ...(S[L.code] || {}) };
  const opts = LANGS.map((l) => `<option value="${l.code}"${l.code === L.code ? " selected" : ""}>${esc(l.name)}</option>`).join("");
  const boot = { lang: L.code, locale: L.locale, dict, studio, links, apiBase };
  return `<!doctype html>
<html lang="${esc(L.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0d0e13">
<title>${esc(studio.name)} — ${esc(dict.title)}</title>
<style>
:root{--bg:#0d0e13;--bg-2:#13151c;--bg-3:#1a1d26;--line:#262a36;--text:#eceef5;--muted:#8b91a3;--accent:#7c5cff;--accent-2:#a78bfa;--ok:#3ecf8e;--warn:#f5b84a;--danger:#ff5c6c;--patreon:#f96854;--substar:#009688}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans JP","Noto Sans SC","Noto Sans TC",sans-serif;-webkit-text-size-adjust:100%}
body{min-height:100dvh;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
a{color:var(--accent-2)}
.wrap{max-width:560px;margin:0 auto;padding:16px 16px 40px}
header{display:flex;align-items:center;gap:12px;padding:6px 0 14px}
header img{height:40px;width:auto}
header .name{font-weight:800;letter-spacing:.2px;font-size:17px;flex:1;line-height:1.2}
header .name small{display:block;color:var(--muted);font-weight:500;font-size:12px}
select{appearance:none;-webkit-appearance:none;background:var(--bg-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b91a3' stroke-width='3'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center;border:1px solid var(--line);color:var(--text);border-radius:10px;padding:9px 30px 9px 12px;font:inherit;font-size:14px}
.card{background:var(--bg-2);border:1px solid var(--line);border-radius:16px;padding:16px;margin:0 0 14px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.hero{position:relative;border-radius:16px 16px 0 0;margin:-16px -16px 14px;aspect-ratio:16/9;background:#1b1e2b center/cover no-repeat;overflow:hidden}
.hero::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(19,21,28,1),rgba(19,21,28,.1) 60%)}
.hero .t{position:absolute;left:16px;right:16px;bottom:12px;z-index:1}
h1{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.2px}
.tag{margin:4px 0 0;color:var(--muted);font-size:14px}
h2{font-size:15px;margin:0 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
p{margin:0 0 12px}
.muted{color:var(--muted)}.small{font-size:13px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px 18px;border:0;border-radius:12px;font:inherit;font-weight:700;font-size:16px;color:#fff;background:var(--accent);box-shadow:0 6px 20px rgba(124,92,255,.35);cursor:pointer;text-decoration:none;min-height:52px}
.btn:disabled{opacity:.5;box-shadow:none;cursor:default}
.btn.patreon{background:var(--patreon);box-shadow:0 6px 20px rgba(249,104,84,.3)}
.btn.substar{background:var(--substar);box-shadow:0 6px 20px rgba(0,150,136,.3)}
.btn.ghost{background:var(--bg-3);color:var(--text);box-shadow:none;border:1px solid var(--line)}
.btn.small{padding:9px 14px;font-size:14px;min-height:0;width:auto;display:inline-flex}
.stack{display:grid;gap:10px}
.account{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.avatar{width:40px;height:40px;border-radius:50%;background:var(--bg-3);display:grid;place-items:center;font-weight:700;overflow:hidden;flex:none}
.avatar img{width:100%;height:100%;object-fit:cover}
.account .who{flex:1;min-width:0}.account .who b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--muted)}.dot.patreon{background:var(--patreon)}.dot.substar{background:var(--substar)}.dot.code{background:var(--ok)}
.note{padding:12px 14px;border-radius:12px;font-size:14px;line-height:1.5;margin:0 0 12px;background:rgba(255,92,108,.08);border:1px solid rgba(255,92,108,.25);color:#ffb3bb}
.note.info{background:rgba(124,92,255,.08);border-color:rgba(124,92,255,.3);color:#cfc6ff}
.note a{color:#fff}
.note .btn{margin-top:10px}
.check{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;margin:4px 0 14px;font-size:14px;line-height:1.45}
.check input{width:20px;height:20px;margin-top:1px;accent-color:var(--accent)}
.ver{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:0 0 6px}
.ver b{font-size:18px}
.notes{color:var(--muted);font-size:14px;white-space:pre-line;margin:8px 0 14px}
details{border-top:1px solid var(--line);margin-top:14px;padding-top:10px}
summary{cursor:pointer;color:var(--muted);font-size:14px}
.old{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}
.old:last-child{border-bottom:0}
ol{margin:0;padding-left:20px}ol li{margin:0 0 8px;font-size:14px}
.code-row{margin-top:12px;text-align:center;font-size:14px}
.code-form{display:flex;gap:8px;margin-top:10px}.code-form .btn{flex:none}
.code-form input{flex:1;min-width:0;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit;font-size:16px;letter-spacing:1px;text-transform:uppercase}
footer{text-align:center;color:var(--muted);font-size:13px;padding:10px 0}
footer a{color:var(--muted)}
.status{color:var(--muted);font-size:14px;text-align:center;margin-top:10px}
.err{color:var(--danger)}
.hidden{display:none!important}
@media (min-width:700px){.wrap{padding-top:32px}h1{font-size:28px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    ${studio.logo ? `<img src="${esc(studio.logo)}" alt="">` : ""}
    <div class="name">${esc(studio.name)}<small>${esc(dict.title)} · ${esc(dict.adultNote)}</small></div>
    <select id="lang" aria-label="Language">${opts}</select>
  </header>
  <main id="app"><p class="status">${esc(dict.loading)}</p></main>
  <footer>
    <a href="${esc(links.eula || "#")}" target="_blank" rel="noopener">${esc(dict.eula)}</a> · <a href="${esc(links.privacy || "#")}" target="_blank" rel="noopener">${esc(dict.privacy)}</a>
    <div id="desktop" style="margin-top:6px"></div>
  </footer>
</div>
<script>
const BOOT = ${JSON.stringify(boot)};
const D = BOOT.dict, API = BOOT.apiBase;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (k, v = {}) => (D[k] || k).replace(/\\{(\\w+)\\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
const th = (k, v = {}) => { const s = {}; for (const [a, b] of Object.entries(v)) s[a] = esc(b); return t(k, s).replace(/\\*\\*(.+?)\\*\\*/g, "<b>$1</b>")
  .replace(/\\[(eula|privacy|launcher)\\](.+?)\\[\\/\\1\\]/g, (m, a, x) => '<a href="' + esc(BOOT.links[a] || "#") + '" target="_blank" rel="noopener">' + x + '</a>'); };
const fmtBytes = (n) => { if (!n) return ""; const u = ["B","KB","MB","GB"]; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + " " + u[i]; };
const fmtDate = (ms) => new Date(ms).toLocaleString(BOOT.locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const L = (v) => (typeof v === "string" ? v : v && typeof v === "object" ? (v[BOOT.lang] ?? v.en ?? Object.values(v)[0] ?? "") : "");
const dayLabel = (d) => (d > 0 ? t("dayN", { n: d + 1 }) : t("dayOne"));
const $ = (s) => document.querySelector(s);
document.getElementById("lang").onchange = (e) => { document.cookie = "lang=" + e.target.value + "; path=/; max-age=31536000; samesite=lax"; location.search = "?lang=" + e.target.value; };
document.getElementById("desktop").innerHTML = BOOT.links.launcher ? th("desktop") : "";
let state = null;
async function load() {
  try {
    const r = await fetch(API + "/android/api/state", { credentials: "same-origin" });
    state = await r.json();
    render();
  } catch (e) { $("#app").innerHTML = '<p class="status err">' + esc(t("error", { message: String(e) })) + "</p>"; }
}
function ageOk() { try { return localStorage.getItem("ageOk") === "1"; } catch { return false; } }
function render() {
  const a = state.account, g = state.games[0];
  const q = new URLSearchParams(location.search);
  let html = "";
  if (g) {
    html += '<section class="card">';
    html += '<div class="hero" style="background-image:url(&quot;' + esc(g.hero || g.cover || "") + '&quot;)"><div class="t"><h1>'  + esc(g.title) + '</h1>' + (L(g.tagline) ? '<p class="tag">' + esc(L(g.tagline)) + '</p>' : '') + '</div></div>';
    if (!a) {
      html += '<p class="muted small">' + esc(t("intro", { studio: BOOT.studio.name })) + '</p>';
      if (q.get("error")) html += '<p class="status err">' + esc(t("loginFailed")) + '</p>';
      html += '<div class="stack"><a class="btn patreon" href="' + API + '/android/login/patreon">' + esc(t("patreon")) + '</a><a class="btn substar" href="' + API + '/android/login/subscribestar">' + esc(t("substar")) + '</a></div>';
      html += '<div class="code-row"><a href="#" id="have-code">' + esc(t("haveCode")) + '</a><form id="code-form" class="code-form hidden"><input id="code" autocomplete="off" spellcheck="false" placeholder="' + esc(state.codePlaceholder || "XXXX-XXXX-XXXX") + '"><button class="btn small" type="submit">' + esc(t("codeGo")) + '</button></form><p id="code-status" class="status err hidden"></p></div>';
    } else {
      const initials = (a.displayName || "?").split(/\\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
      html += '<div class="account"><div class="avatar">' + (a.avatar ? '<img src="' + esc(a.avatar) + '" alt="">' : esc(initials)) + '</div><div class="who"><b>' + esc(a.displayName) + '</b><span class="muted small"><span class="dot ' + (a.provider === "patreon" ? "patreon" : a.provider === "subscribestar" ? "substar" : "code") + '"></span>' + esc(a.tierName || t("tier", { n: a.tier })) + '</span></div><button class="btn ghost small" id="signout">' + esc(t("signOut")) + '</button></div>';
      const and = g.android || {};
      const vers = and.versions || [];
      const open = vers.filter((v) => v.access.ok);
      const cur = open[0];
      const pend = vers.find((v) => !v.access.ok && v.access.reason === "window");
      const locked = g.requiredTier > 0 && a.tier < g.requiredTier;
      if (!vers.length) {
        html += '<p class="muted">' + esc(t("noAndroid")) + '</p>';
      } else if (locked) {
        html += '<div class="note">' + th("locked", { tier: g.requiredTierName || "", current: a.tierName || t("tier", { n: a.tier }) }) + ' <a href="#" id="recheck">' + esc(t("recheck")) + '</a>' + (state.upgradeUrl ? '<a class="btn small" style="display:flex" href="' + esc(state.upgradeUrl) + '" target="_blank" rel="noopener">' + esc(t("upgrade")) + '</a>' : '') + '</div>';
      } else {
        if (cur) {
          html += '<h2>' + esc(t("latestForYou")) + '</h2><div class="ver"><b>v' + esc(cur.version) + '</b><span class="muted small">' + esc(t("size", { size: fmtBytes(cur.size) })) + '</span></div>';
          if (L(cur.notes)) html += '<div class="notes">' + esc(L(cur.notes)) + '</div>';
          html += '<label class="check"><input type="checkbox" id="age"' + (ageOk() ? ' checked' : '') + '><span>' + th("age") + '</span></label>';
          html += '<a class="btn" id="dl" href="' + API + '/android/download/' + encodeURIComponent(g.id) + '/' + encodeURIComponent(cur.version) + '"' + (ageOk() ? '' : ' aria-disabled="true" style="opacity:.5;pointer-events:none"') + '>⬇ ' + esc(t("download", { version: cur.version })) + '</a><p id="dl-status" class="status hidden">' + esc(t("downloading")) + '</p>';
        }
        if (pend) html += '<div class="note info" style="margin-top:14px">' + th("pending", { version: pend.version, dayOne: state.dayOneTierName || t("aDayOneTier"), tier: a.tierName || t("yourTier"), day: dayLabel(a.delayDays || 0), date: fmtDate(pend.access.availableAt) }) + (state.upgradeUrl ? ' ' + esc(t("pendingUpgrade")) : '') + ' <a href="#" id="recheck">' + esc(t("recheck")) + '</a>' + (state.upgradeUrl ? '<a class="btn small" style="display:flex" href="' + esc(state.upgradeUrl) + '" target="_blank" rel="noopener">' + esc(t("upgrade")) + '</a>' : '') + '</div>';
        if (open.length > 1) html += '<details><summary>' + esc(t("older")) + '</summary>' + open.slice(1).map((v) => '<div class="old"><span><b>v' + esc(v.version) + '</b> <span class="muted">' + esc(fmtBytes(v.size)) + '</span></span><a class="btn ghost small" href="' + API + '/android/download/' + encodeURIComponent(g.id) + '/' + encodeURIComponent(v.version) + '">⬇</a></div>').join("") + '</details>';
      }
    }
    html += '</section>';
  } else {
    html += '<section class="card"><p class="muted">' + esc(t("noAndroid")) + '</p></section>';
  }
  html += '<section class="card"><h2>' + esc(t("howtoTitle")) + '</h2><ol><li>' + esc(t("howto1")) + '</li><li>' + esc(t("howto2")) + '</li><li>' + esc(t("howto3")) + '</li><li>' + esc(t("howto4")) + '</li></ol></section>';
  $("#app").innerHTML = html;
  const hc = $("#have-code"); if (hc) hc.onclick = (e) => { e.preventDefault(); $("#code-form").classList.toggle("hidden"); $("#code").focus(); };
  const cf = $("#code-form"); if (cf) cf.onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch(API + "/android/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: $("#code").value.trim() }), credentials: "same-origin" });
    if (r.ok) load(); else { const st = $("#code-status"); st.textContent = t("codeInvalid"); st.classList.remove("hidden"); }
  };
  const so = $("#signout"); if (so) so.onclick = async () => { await fetch(API + "/android/logout", { method: "POST", credentials: "same-origin" }); load(); };
  const rc = $("#recheck"); if (rc) rc.onclick = (e) => { e.preventDefault(); load(); };
  const age = $("#age"); if (age) age.onchange = () => { try { localStorage.setItem("ageOk", age.checked ? "1" : "0"); } catch {} const dl = $("#dl"); if (age.checked) { dl.removeAttribute("aria-disabled"); dl.style.opacity = ""; dl.style.pointerEvents = ""; } else { dl.setAttribute("aria-disabled", "true"); dl.style.opacity = ".5"; dl.style.pointerEvents = "none"; } };
  const dl = $("#dl"); if (dl) dl.onclick = () => { $("#dl-status").classList.remove("hidden"); };
}
load();
</script>
</body>
</html>`;
}
