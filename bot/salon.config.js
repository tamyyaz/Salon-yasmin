// Bot settings. Hours come from the web app's src/config.js so the two never disagree.
import { config as web } from '../src/config.js';

export default {
  name: web.salonName,
  currency: web.currency,
  openHour: web.openHour,
  closeHour: web.closeHour,
  slotMinutes: web.slotMinutes,
  salonEmail: web.salonEmail,

  assistantName: 'ليان',                             // the name the assistant introduces herself with (can be changed in the app)

  timezone: process.env.SALON_TZ || 'Asia/Amman',   // the salon's local time zone (IANA name)
  closedWeekdays: [],                                // 0 = Sunday … 6 = Saturday, e.g. [5] if closed on Fridays
  minLeadMinutes: 60,                                // no bookings starting sooner than this
  maxDaysAhead: 45,
  maxActivePerCustomer: 3,                           // open requests/bookings one phone number may hold

  // The assistant quotes ONLY what is listed here. Put `price: null` if the price is agreed at the salon.
  services: [
    { name: 'قص شعر', price: null },
    { name: 'سيشوار', price: null },
    { name: 'صبغة', price: null },
    { name: 'عناية بالبشرة', price: null },
    { name: 'مناكير / باديكير', price: null },
  ],
};
