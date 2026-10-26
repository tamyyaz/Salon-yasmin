// Small Arabic text helpers for the menu assistant (no AI involved).
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Lower-case, Latin digits, no diacritics, unified letter forms, punctuation → spaces. */
export function norm(s) {
  return String(s ?? '')
    .replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d))
    .replace(/[۰-۹]/g, (d) => FA_DIGITS.indexOf(d))
    .replace(/[ً-ٰٟـ]/g, '')       // tashkeel + tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:/.\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const tokens = (s) => norm(s).split(' ').filter(Boolean);

const STOP = new Set(['شو', 'ما', 'هل', 'كيف', 'في', 'من', 'الى', 'علي', 'عن', 'مع', 'هو', 'هي', 'او', 'لو', 'بدي', 'بدك', 'عندكم', 'عندك', 'يا', 'ال',
  'لا', 'كم', 'اذا', 'هاد', 'هاي', 'هون', 'شي', 'بس', 'كل', 'انا', 'انت', 'ايه', 'اي', 'هيك', 'لكن', 'يعني', 'ممكن', 'بتقدر', 'بتقدروا']);

/** Words that carry meaning (drops one-letter words, stop words and a leading "ال"). */
export const keywords = (s) => tokens(s).map((t) => (t.startsWith('ال') && t.length > 3 ? t.slice(2) : t)).filter((t) => t.length > 1 && !STOP.has(t));

/** True when the normalised text contains any of the (already normalised) phrases. */
export const mentions = (normText, phrases) => phrases.some((p) => normText.includes(p));

/** Whole-message answers. */
export const isYes = (n) => /^(نعم|ايوه|ايوا|اي|ايه|تمام|اكيد|اوكي|اوك|ok|okay|yes|y|صح|موافقه|موافق|اكد|تاكيد|ثبت|ثبتي|يلا|1)$/.test(n);
export const isNo = (n) => /^(لا|لأ|no|n|ما بدي|لا شكرا|الغاء|الغي|كنسل|0|2)$/.test(n) || n === 'لا';
