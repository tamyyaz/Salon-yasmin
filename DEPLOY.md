# النشر على Firebase (`web.app`) وتجهيز التابلت

> **استخدم مشروع Firebase جديد وفاضي للصالون** (مو مشروع فيه تطبيقات أو بيانات ثانية). قواعد Firestore والمستخدمين
> بتكون على مستوى المشروع كله، فخلط الصالون مع منصة ثانية بيعرّض الاتنين للخطر. الدومين بيكون `<project-id>.web.app`.

## 1) إعداد المشروع (طريقة سريعة: سكربت)

من الـ Console، 3 خطوات (دقيقتين):

1. **Add project** ← سمّه مثلاً `salon-yasmin` (الـ Project ID بيصير دومينك) ← عطّل Google Analytics.
2. **Build ← Firestore Database ← Create database** ← *Production mode* ← أقرب منطقة (ما بتتغيّر بعدين).
3. **Build ← Authentication ← Get started ← Sign-in method ← Email/Password ← Enable.**

ثم: **Project settings ← Service accounts ← Generate new private key** (بينزل ملف JSON — لا ترفعه لـ git أبداً). وشغّل:

```bash
npm install
node scripts/setup-firebase.mjs --key /path/to/key.json --dry-run   # فحص فقط، ما بيغيّر شي
node scripts/setup-firebase.mjs --key /path/to/key.json             # الإعداد الفعلي
```

السكربت: يتأكد إن المشروع فاضي (وبيرفض يلمس مشروع فيه تطبيقات أو بيانات أو موقع منشور)، يسجّل تطبيق الويب ويكتب إعداداته
بـ `src/config.js` و`.firebaserc`، ينشئ حساب الصالون (`salon@yasmin.app` وكلمة سر عشوائية بتظهر مرة وحدة، بتغيّرها من
Authentication ← Users)، ثم يبني وينشر القواعد والموقع.
إذا رفضت أداة Firebase CLI المفتاح (تحتاج صلاحيات إضافية) بينشر عبر REST تلقائياً (`scripts/deploy-rest.mjs`).
لنشر تحديث لاحقاً بنفس المفتاح: `npm run build && node scripts/deploy-rest.mjs --key /path/key.json`.
**بعدها احذف المفتاح** من Google Cloud ← IAM ← Service accounts ← Keys.

### الطريقة اليدوية (بدل السكربت)

1. Project settings ← Your apps ← `</>` ← سجّل تطبيق ويب وانسخ `firebaseConfig` إلى `src/config.js`، وضع Project ID بـ `.firebaserc`.
2. Authentication ← Users ← **Add user**: `salon@yasmin.app` + كلمة السر. (عطّل **Enable create (sign-up)** إن وُجد.)
3. Firestore ← **Rules** ← الصق `firestore.rules` ← Publish.
4. `npx firebase login` ثم `npm run deploy`.

> البريد `salon@yasmin.app` مكتوب بمكانين: `src/config.js` و`firestore.rules`. إذا غيّرته غيّره بالاثنين.

## 2) النشر التلقائي من GitHub (اختياري)

الـ workflow جاهز (`.github/workflows/deploy.yml`): كل دمج بفرع `main` بيبني الموقع وبينشره على `web.app`.
بدو سرّ واحد (استخدم حساب خدمة مخصّص بصلاحيات محدودة، مش مفتاح الـ Admin SDK):

1. Google Cloud Console ← IAM & Admin ← **Service Accounts** ← Create: اسمه `github-deploy`
   بصلاحيات **Firebase Hosting Admin** و**API Keys Viewer** و**Firebase Rules Admin** (الأخيرة لنشر قواعد الأمان تلقائياً).
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
