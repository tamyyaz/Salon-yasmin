# النشر على Firebase (`web.app`) وتجهيز التابلت

مشروع Firebase الحالي عندك (اللي دومينه `xxxx.web.app`) بيكفي. `xxxx` هو **Project ID**.

## 1) إعدادات Firebase (مرة وحدة، من الـ Console)

1. **تطبيق ويب:** Project settings ← General ← Your apps ← أيقونة `</>` ← سمّه «salon» (بدون Hosting)
   ← انسخ قيم `firebaseConfig`.
2. ضعها في `src/config.js` مكان `REPLACE_…` (apiKey, authDomain, projectId, appId).
   وغيّر `salonName` و`currency` و`openHour/closeHour` إذا بدك.
3. **الدخول:** Build ← Authentication ← Get started ← Sign-in method ← فعّل **Email/Password**.
   ثم Users ← **Add user**: البريد `salon@yasmin.app` وكلمة السر اللي بدك (هي كلمة سر الصالون).
   وإذا لقيت بـ Settings ← User actions خيار **Enable create (sign-up)** عطّله (حماية إضافية).
4. **القاعدة:** Build ← Firestore Database ← Create database ← **Production mode** ← اختر أقرب منطقة (لا تتغيّر بعدين).
5. **قواعد الأمان (مهم جداً):** Firestore ← تبويب **Rules** ← الصق محتوى `firestore.rules` كله ← **Publish**.
   (أو من جهازك: `npx firebase login` ثم `npx firebase deploy --only firestore:rules`.)
6. ضع Project ID في `.firebaserc` (مكان `YOUR-PROJECT-ID`).

> البريد `salon@yasmin.app` مكتوب بمكانين: `src/config.js` و`firestore.rules`. إذا غيّرته غيّره بالاثنين.

## 2) النشر التلقائي من GitHub

الـ workflow جاهز (`.github/workflows/deploy.yml`): كل دمج بفرع `main` بيبني الموقع وبينشره على `web.app`.
بدو سرّ واحد:

1. Google Cloud Console ← IAM & Admin ← **Service Accounts** ← Create: اسمه `github-deploy`
   بصلاحيات **Firebase Hosting Admin** و**API Keys Viewer**.
2. على الحساب: Keys ← Add key ← **JSON** (بينزل ملف).
3. GitHub ← مستودع `Salon-yasmin` ← Settings ← Secrets and variables ← Actions ← **New repository secret**:
   الاسم `FIREBASE_SERVICE_ACCOUNT` والقيمة محتوى ملف JSON كله.
4. ادمج الفرع بـ `main` (Pull request ← Merge) أو شغّل الـ workflow يدوياً من تبويب Actions.

بعد دقيقتين الموقع على `https://<project-id>.web.app`.

**نشر يدوي بدل GitHub (بديل):** `npx firebase login` ثم `npm run deploy`.

## 3) تثبيت على التابلت (Chrome)

1. افتح `https://<project-id>.web.app` وسجّل الدخول بكلمة السر.
2. قائمة ⋮ ← **Install app / تثبيت التطبيق** (أو Add to Home screen). بيطلع أيقونة وردية وبيفتح بملء الشاشة.
3. **إبقاء الشاشة مفتوحة:** زر ☀ بأعلى الموقع، ومن إعدادات التابلت: Stay awake أثناء الشحن / مهلة الشاشة أطول.
4. خلّي التابلت على الشاحن، واستثنِ Chrome من توفير البطارية.
5. إذا انقطع النت: بيضل الموقع شغّال، وبتنحفظ الحجوزات على التابلت وبتتزامن لما يرجع.

لإضافة جهاز تاني (جوالك مثلاً): افتح نفس الرابط وسجّل الدخول — كل شي بيتزامن لحظياً.

## الحدود والتكلفة

- الخطة المجانية (Spark): Firestore 1GB تخزين و50 ألف قراءة و20 ألف كتابة يومياً، Hosting 10GB/شهر — أكتر من كافي لصالون.
- إذا تجاوزت الحصة (غير متوقع) بيتوقف الحفظ لحد اليوم التالي، ما بتنفرض عليك فاتورة بدون ما تفعّل الدفع.

## النسخ الاحتياطي

- زر **تحميل نسخة احتياطية** بصفحة الملاحظات بينزّل كل البيانات JSON. يُفضّل مرة بالشهر.
- Firebase بيحفظ البيانات على سيرفراته؛ الحذف بالغلط هو الخطر الحقيقي، فالنسخة اليدوية مهمة.

## الأمان

- كلمة سر قوية. Firebase بيحدّ المحاولات الغلط تلقائياً.
- مفتاح `apiKey` ظاهر بالصفحة وهذا طبيعي: الحماية من الدخول + `firestore.rules`.
- لتغيير كلمة السر: Authentication ← Users ← المستخدم ← Reset password / عدّل كلمة السر.
