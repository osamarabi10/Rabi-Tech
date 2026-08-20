'use client';

/**
 * Lightweight i18n: UI strings are written in Arabic (the source language)
 * and used directly as translation keys. Hebrew/English are looked up here;
 * anything missing falls back to the Arabic source so the UI never breaks.
 * Customer-facing WhatsApp templates are NOT affected — they stay Arabic.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Locale = 'ar' | 'he' | 'en';

const RTL: Record<Locale, boolean> = { ar: true, he: true, en: false };

type Dict = Record<string, { he: string; en: string }>;

const D: Dict = {
  // ---- Navigation / chrome ----
  'الرسائل': { he: 'הודעות', en: 'Messages' },
  'التذاكر': { he: 'קריאות שירות', en: 'Tickets' },
  'الحملات': { he: 'קמפיינים', en: 'Campaigns' },
  'جهات الاتصال': { he: 'אנשי קשר', en: 'Contacts' },
  'نظرة عامة': { he: 'סקירה כללית', en: 'Overview' },
  'القوالب': { he: 'תבניות', en: 'Templates' },
  'الإعدادات': { he: 'הגדרות', en: 'Settings' },
  'الاستخدام الشهري': { he: 'שימוש חודשי', en: 'Monthly usage' },
  'الرسائل الواردة': { he: 'הודעות נכנסות', en: 'Inbound messages' },
  'الرسائل الصادرة': { he: 'הודעות יוצאות', en: 'Outbound messages' },
  'جهات الاتصال النشطة': { he: 'אנשי קשר פעילים', en: 'Active contacts' },
  'رموز الذكاء الاصطناعي الواردة': { he: 'טוקני AI נכנסים', en: 'AI input tokens' },
  'رموز الذكاء الاصطناعي الصادرة': { he: 'טוקני AI יוצאים', en: 'AI output tokens' },
  'إرسالات الحملات': { he: 'שליחות קמפיין', en: 'Campaign sends' },
  'غير محدود': { he: 'ללא הגבלה', en: 'Unlimited' },
  'وصلت للحد الشهري': { he: 'המכסה החודשית נוצלה', en: 'Monthly limit reached' },
  'قريب من الحد الشهري': { he: 'קרוב למכסה החודשית', en: 'Near monthly limit' },
  'تسجيل الخروج': { he: 'התנתקות', en: 'Log out' },
  'جاري التحقق من الجلسة...': { he: 'מאמת חיבור...', en: 'Verifying session...' },
  'تشغيل': { he: 'תפעול', en: 'Operations' },
  'نظام': { he: 'מערכת', en: 'System' },
  'اللغة': { he: 'שפה', en: 'Language' },
  'المستخدم': { he: 'משתמש', en: 'User' },
  'متصل بالخادم': { he: 'שרת מחובר', en: 'Server connected' },
  'الخادم غير متصل': { he: 'שרת לא מחובר', en: 'Server offline' },
  'مفتوحة': { he: 'פתוחות', en: 'Open' },
  'معلقة': { he: 'ממתינות', en: 'Pending' },
  'مُسندة لي': { he: 'שלי', en: 'Mine' },
  'محلولة': { he: 'פתורות', en: 'Resolved' },
  'تفاصيل جهة الاتصال': { he: 'פרטי איש קשר', en: 'Contact details' },
  'الوكيل': { he: 'נציג', en: 'Agent' },
  'غير مُسند': { he: 'לא מוקצה', en: 'Unassigned' },
  'تقييم العميل': { he: 'דירוג לקוח', en: 'Customer rating' },
  'التذكرة': { he: 'כרטיס', en: 'Ticket' },
  'عرض جهة الاتصال': { he: 'הצג איש קשר', en: 'View contact' },
  'اختر محادثة': { he: 'בחר שיחה', en: 'Select a conversation' },
  'اختر محادثة من القائمة أو ابدأ محادثة جديدة': { he: 'בחר שיחה מהרשימה', en: 'Select a conversation or start a new one' },
  'معلق': { he: 'ממתין', en: 'Pending' },
  'إعادة فتح': { he: 'פתח מחדש', en: 'Reopen' },
  'تم تعيين المحادثة كـ معلقة': { he: 'שיחה סומנה כממתינה', en: 'Marked as pending' },
  'تم تعيين الوكيل': { he: 'נציג הוקצה', en: 'Agent assigned' },
  'تم إلغاء التعيين': { he: 'הוקצאה בוטלה', en: 'Assignment removed' },
  'فشل التعيين': { he: 'שגיאה בהקצאה', en: 'Assignment failed' },
  'ملاحظات': { he: 'הערות', en: 'Notes' },
  'حل': { he: 'סגור', en: 'Resolve' },
  'تم النسخ': { he: 'הועתק', en: 'Copied' },

  // ---- Login ----
  'RabiTech': { he: 'RabiTech', en: 'RabiTech' },
  'تسجيل الدخول للوحة التحكم': { he: 'התחברות ללוח הבקרה', en: 'Sign in to the dashboard' },
  'البريد الإلكتروني': { he: 'אימייל', en: 'Email' },
  'كلمة المرور': { he: 'סיסמה', en: 'Password' },
  'دخول': { he: 'כניסה', en: 'Sign in' },
  'جاري الدخول...': { he: 'מתחבר...', en: 'Signing in...' },
  'البريد الإلكتروني أو كلمة المرور غير صحيحة — أو الخادم غير متصل': {
    he: 'אימייל או סיסמה שגויים — או שהשרת לא מחובר',
    en: 'Wrong email or password — or the server is offline',
  },
  'متصل بالخادم — بيانات حقيقية من واتساب وقاعدة البيانات': {
    he: 'מחובר לשרת — נתונים אמיתיים מוואטסאפ וממסד הנתונים',
    en: 'Connected — live WhatsApp and database data',
  },

  // ---- Inbox ----
  'مجموعات': { he: 'קבוצות', en: 'Groups' },
  'مارك': { he: 'שיווק', en: 'Marketing' },
  'محادثة جديدة': { he: 'שיחה חדשה', en: 'New chat' },
  'لا توجد محادثات': { he: 'אין שיחות', en: 'No conversations' },
  'جاري التحميل...': { he: 'טוען...', en: 'Loading...' },
  'بحث في المحادثات...': { he: 'חיפוש בשיחות...', en: 'Search conversations...' },
  'بحث في المجموعات...': { he: 'חיפוש בקבוצות...', en: 'Search groups...' },
  'عرض النشطة فقط': { he: 'הצג פעילות בלבד', en: 'Show active only' },
  'عرض المحلولة': { he: 'הצג סגורות', en: 'Show resolved' },
  'تحديث': { he: 'רענון', en: 'Refresh' },
  'لا توجد مجموعات — اربط واتساب من الإعدادات': {
    he: 'אין קבוצות — חבר וואטסאפ בהגדרות',
    en: 'No groups — connect WhatsApp in Settings',
  },
  'جاري تحميل الرسائل...': { he: 'טוען הודעות...', en: 'Loading messages...' },
  'لا توجد رسائل بعد في هذه المجموعة': { he: 'אין עדיין הודעות בקבוצה זו', en: 'No messages in this group yet' },
  'الرسائل الجديدة ستظهر هنا تلقائياً': { he: 'הודעות חדשות יופיעו כאן אוטומטית', en: 'New messages will appear here automatically' },
  'اختر مجموعة من القائمة': { he: 'בחר קבוצה מהרשימה', en: 'Select a group from the list' },
  'اختر محادثة من القائمة': { he: 'בחר שיחה מהרשימה', en: 'Select a conversation from the list' },
  'اكتب رسالة...': { he: 'כתוב הודעה...', en: 'Type a message...' },
  'اكتب رسالة للمجموعة...': { he: 'כתוב הודעה לקבוצה...', en: 'Message the group...' },
  'نفس خط واتساب الدعم — تظهر هنا كل الرسائل الواردة': {
    he: 'אותו קו וואטסאפ של התמיכה — כל ההודעות הנכנסות מוצגות כאן',
    en: 'Same WhatsApp line as support — all incoming messages appear here',
  },
  'تنبيهات الشبكة': { he: 'התראות רשת', en: 'Network alerts' },
  'تنبيهات': { he: 'התראות', en: 'Alerts' },
  'لا توجد تنبيهات': { he: 'אין התראות', en: 'No alerts' },
  'إغلاق التذكرة': { he: 'סגירת קריאה', en: 'Close ticket' },
  'تأكيد الإغلاق': { he: 'אישור סגירה', en: 'Confirm close' },
  'سيتم إغلاق التذكرة وإرسال رسالة تقييم تلقائية للعميل': {
    he: 'הקריאה תיסגר ותישלח ללקוח הודעת דירוג אוטומטית עבור',
    en: 'The ticket will be closed and an automatic rating message will be sent to',
  },
  'إرسال تقني': { he: 'שליחת טכנאי', en: 'Dispatch technician' },
  'إشعار عطل': { he: 'הודעת תקלה', en: 'Outage notice' },
  'حملة جديدة': { he: 'קמפיין חדש', en: 'New campaign' },
  'تحويل لـ IT': { he: 'העברה ל-IT', en: 'Transfer to IT' },
  'رقم الهاتف *': { he: 'מספר טלפון *', en: 'Phone number *' },
  'اسم العميل (اختياري)': { he: 'שם הלקוח (אופציונלי)', en: 'Customer name (optional)' },
  'يفتح المحادثة فوراً — اكتب ردك من صندوق الرسائل بعد الفتح.': {
    he: 'פותח את השיחה מיד — כתוב את תגובתך בתיבת ההודעות.',
    en: 'Opens the chat immediately — type your reply in the message box.',
  },
  'إلغاء': { he: 'ביטול', en: 'Cancel' },
  'العميل:': { he: 'לקוח:', en: 'Customer:' },
  'تأكيد الإرسال': { he: 'אישור שליחה', en: 'Confirm send' },
  'إشعار عطل منطقة': { he: 'הודעת תקלה אזורית', en: 'Zone outage notice' },
  'المنطقة المتأثرة': { he: 'אזור מושפע', en: 'Affected zone' },
  'الوقت المتوقع للإصلاح': { he: 'זמן תיקון משוער', en: 'Estimated fix time' },
  'إرسال للمشتركين': { he: 'שליחה למנויים', en: 'Send to subscribers' },
  'أدخل رقم الهاتف': { he: 'הזן מספר טלפון', en: 'Enter a phone number' },
  'تم فتح المحادثة ✅': { he: 'השיחה נפתחה ✅', en: 'Chat opened ✅' },
  'فشل فتح المحادثة': { he: 'פתיחת השיחה נכשלה', en: 'Failed to open chat' },
  'جاري الفتح...': { he: 'פותח...', en: 'Opening...' },
  'فتح المحادثة': { he: 'פתיחת שיחה', en: 'Open chat' },
  '0501234567 أو 972501234567': { he: '0501234567 או 972501234567', en: '0501234567 or 972501234567' },
  'مثال: أحمد محمد': { he: 'לדוגמה: אחמד מוחמד', en: 'e.g. Ahmad Mohammad' },
  'اختر المنطقة...': { he: 'בחר אזור...', en: 'Select zone...' },
  'مثال: خلال ساعتين': { he: 'לדוגמה: תוך שעתיים', en: 'e.g. within 2 hours' },
  'فشل تحميل المحادثات — تحقق من الخادم': { he: 'טעינת השיחות נכשלה — בדוק את השרת', en: 'Failed to load chats — check the server' },
  'تعذر تحميل المجموعات — تأكد أن واتساب متصل': { he: 'טעינת הקבוצות נכשלה — ודא שוואטסאפ מחובר', en: "Couldn't load groups — make sure WhatsApp is connected" },
  'تعذر تحميل رسائل المجموعة': { he: 'טעינת הודעות הקבוצה נכשלה', en: "Couldn't load group messages" },
  'رسالة جديدة 📩': { he: 'הודעה חדשה 📩', en: 'New message 📩' },
  'وصلتك رسالة واتساب جديدة': { he: 'התקבלה הודעת וואטסאפ חדשה', en: 'You received a new WhatsApp message' },
  'رسالة مجموعة جديدة 👥': { he: 'הודעת קבוצה חדשה 👥', en: 'New group message 👥' },
  'وصلت رسالة جديدة في إحدى المجموعات': { he: 'התקבלה הודעה חדשה באחת הקבוצות', en: 'New message in one of the groups' },
  'فشل إرسال الرسالة — تحقق من اتصال الخادم': { he: 'שליחת ההודעה נכשלה — בדוק את החיבור לשרת', en: 'Failed to send — check the server connection' },
  'تم إغلاق المحادثة — العميل سيحصل على رسالة التقييم ✅': { he: 'השיחה נסגרה — הלקוח יקבל הודעת דירוג ✅', en: 'Chat closed — the customer will get a rating message ✅' },
  'فشل تحديث الحالة': { he: 'עדכון הסטטוס נכשל', en: 'Failed to update status' },
  'فشل إرسال التقني': { he: 'שליחת הטכנאי נכשלה', en: 'Failed to dispatch technician' },
  'فشل إرسال إشعار العطل': { he: 'שליחת הודעת התקלה נכשלה', en: 'Failed to send outage notice' },
  'تم إرسال الرسالة للمجموعة ✅': { he: 'ההודעה נשלחה לקבוצה ✅', en: 'Message sent to group ✅' },
  'فشل إرسال الرسالة للمجموعة': { he: 'שליחת ההודעה לקבוצה נכשלה', en: 'Failed to send group message' },
  'تم نسخ معرف المجموعة': { he: 'מזהה הקבוצה הועתק', en: 'Group ID copied' },
  'مجموعة التنبيهات': { he: 'קבוצת התראות', en: 'Alerts group' },
  'التقني': { he: 'טכנאי', en: 'Technician' },
  '45 دقيقة': { he: '45 דקות', en: '45 minutes' },
  'منطقتك': { he: 'האזור שלך', en: 'Your zone' },
  'شكر وتقييم': { he: 'תודה ודירוג', en: 'Thanks & rating' },
  'رد تلقائي': { he: 'מענה אוטומטי', en: 'Auto-reply' },
  '📎 ملف مرفق': { he: '📎 קובץ מצורף', en: '📎 Attached file' },
  'متاح': { he: 'זמין', en: 'Available' },
  'مشغول': { he: 'עסוק', en: 'Busy' },

  // ---- Tickets ----
  'تذاكر الدعم الفني': { he: 'קריאות שירות', en: 'Support tickets' },
  'الكل': { he: 'הכל', en: 'All' },
  'مفتوح': { he: 'פתוח', en: 'Open' },
  'جاري': { he: 'בטיפול', en: 'In progress' },
  'محلول': { he: 'נפתר', en: 'Resolved' },
  'رقم': { he: 'מס׳', en: '#' },
  'العميل': { he: 'לקוח', en: 'Customer' },
  'المنطقة': { he: 'אזור', en: 'Zone' },
  'الأولوية': { he: 'עדיפות', en: 'Priority' },
  'الحالة': { he: 'סטטוס', en: 'Status' },
  'المكلف': { he: 'אחראי', en: 'Assignee' },
  'الوقت': { he: 'זמן', en: 'Time' },
  'لا توجد تذاكر': { he: 'אין קריאות', en: 'No tickets' },

  // ---- Overview ----
  'نظرة عامة — RabiTech': { he: 'סקירה כללית — RabiTech', en: 'Overview — RabiTech' },
  'تسويق': { he: 'שיווק', en: 'Marketing' },
  'التقنيون': { he: 'טכנאים', en: 'Technicians' },
  'آخر التنبيهات': { he: 'התראות אחרונות', en: 'Recent alerts' },
  'دق': { he: 'דק׳', en: 'min' },
  'تذاكر مفتوحة': { he: 'קריאות פתוחות', en: 'Open tickets' },
  'جاري العمل': { he: 'בטיפול', en: 'In progress' },
  'محلولة اليوم': { he: 'נפתרו היום', en: 'Resolved today' },
  'متوسط الاستجابة': { he: 'זמן תגובה ממוצע', en: 'Avg. response' },
  'عملاء محتملون': { he: 'לידים', en: 'Leads' },
  'تم الرد': { he: 'נענו', en: 'Replied' },
  'حملات أُرسلت': { he: 'קמפיינים שנשלחו', en: 'Campaigns sent' },

  // ---- Contacts ----
  'بحث في جهات الاتصال...': { he: 'חיפוש באנשי קשר...', en: 'Search contacts...' },
  'جميع المناطق': { he: 'כל האזורים', en: 'All zones' },
  'لا توجد جهات اتصال': { he: 'אין אנשי קשר', en: 'No contacts' },

  // ---- Campaigns ----
  'الحملات والبث': { he: 'קמפיינים ושידורים', en: 'Campaigns & broadcasts' },
  'لا توجد حملات بعد': { he: 'אין עדיין קמפיינים', en: 'No campaigns yet' },
  'اسم الحملة': { he: 'שם הקמפיין', en: 'Campaign name' },
  'قالب جاهز': { he: 'תבנית מוכנה', en: 'Ready template' },
  'الرسالة': { he: 'הודעה', en: 'Message' },
  'إرسال الحملة': { he: 'שליחת קמפיין', en: 'Send campaign' },
  'قالب العطل': { he: 'תבנית תקלה', en: 'Outage template' },
  'اختر قالباً...': { he: 'בחר תבנית...', en: 'Select a template...' },
  'أدخل اسم الحملة والرسالة': { he: 'הזן שם קמפיין והודעה', en: 'Enter a campaign name and message' },
  'تم إرسال الحملة 🚀': { he: 'הקמפיין נשלח 🚀', en: 'Campaign sent 🚀' },
  'فشل إرسال الحملة — تحقق من الخادم': { he: 'שליחת הקמפיין נכשלה — בדוק את השרת', en: 'Failed to send campaign — check the server' },
  'قالب افتراضي': { he: 'תבנית ברירת מחדל', en: 'Default template' },
  'خلال ساعتين': { he: 'תוך שעתיים', en: 'Within 2 hours' },
  'قريباً': { he: 'בקרוב', en: 'Soon' },

  // ---- Templates ----
  'قوالب الرسائل': { he: 'תבניות הודעות', en: 'Message templates' },
  'قالب جديد': { he: 'תבנית חדשה', en: 'New template' },
  'رد سريع': { he: 'תגובה מהירה', en: 'Quick reply' },
  'حملة': { he: 'קמפיין', en: 'Campaign' },
  'عطل': { he: 'תקלה', en: 'Outage' },
  'خارج الدوام': { he: 'מחוץ לשעות פעילות', en: 'Out of hours' },
  'لا توجد قوالب': { he: 'אין תבניות', en: 'No templates' },
  'اسم القالب': { he: 'שם התבנית', en: 'Template name' },
  'النوع': { he: 'סוג', en: 'Type' },
  'القسم': { he: 'מחלקה', en: 'Department' },
  'دعم تقني': { he: 'תמיכה טכנית', en: 'IT support' },
  'دعم': { he: 'תמיכה', en: 'Support' },
  'نص الرسالة': { he: 'תוכן ההודעה', en: 'Message text' },
  'تعديل القالب': { he: 'עריכת תבנית', en: 'Edit template' },
  'حفظ': { he: 'שמירה', en: 'Save' },
  'إنشاء': { he: 'יצירה', en: 'Create' },
  'أدخل اسم القالب والنص': { he: 'הזן שם תבנית וטקסט', en: 'Enter a template name and text' },
  'تم تحديث القالب': { he: 'התבנית עודכנה', en: 'Template updated' },
  'تم إنشاء القالب': { he: 'התבנית נוצרה', en: 'Template created' },
  'فشل حفظ القالب': { he: 'שמירת התבנית נכשלה', en: 'Failed to save template' },
  'تم حذف القالب': { he: 'התבנית נמחקה', en: 'Template deleted' },
  'فشل حذف القالب': { he: 'מחיקת התבנית נכשלה', en: 'Failed to delete template' },

  // ---- Settings ----
  'أوقات الدوام والرد التلقائي': { he: 'שעות פעילות ומענה אוטומטי', en: 'Working hours & auto-reply' },
  'تفعيل أوقات الدوام': { he: 'הפעלת שעות פעילות', en: 'Enable working hours' },
  'خارج الدوام يُرسل قالب تلقائي للعميل': { he: 'מחוץ לשעות הפעילות נשלחת תבנית אוטומטית ללקוח', en: 'Outside working hours an auto-template is sent' },
  'أيام العمل': { he: 'ימי עבודה', en: 'Working days' },
  'بداية الدوام': { he: 'תחילת יום העבודה', en: 'Start of day' },
  'نهاية الدوام': { he: 'סוף יום העבודה', en: 'End of day' },
  'قالب خارج الدوام': { he: 'תבנית מחוץ לשעות', en: 'Out-of-hours template' },
  'معاينة الرسالة': { he: 'תצוגה מקדימה', en: 'Message preview' },
  'جلسات واتساب': { he: 'חיבורי וואטסאפ', en: 'WhatsApp sessions' },
  'لا توجد جلسات': { he: 'אין חיבורים', en: 'No sessions' },
  'ربط الجهاز': { he: 'קישור מכשיר', en: 'Link device' },
  'مجموعات واتساب': { he: 'קבוצות וואטסאפ', en: 'WhatsApp groups' },
  'الجلسة': { he: 'חיבור', en: 'Session' },
  'اربط واتساب أولاً لعرض المجموعات': { he: 'חבר וואטסאפ תחילה כדי להציג קבוצות', en: 'Connect WhatsApp first to view groups' },
  'لا توجد مجموعات': { he: 'אין קבוצות', en: 'No groups' },
  'إدارة المستخدمين': { he: 'ניהול משתמשים', en: 'User management' },
  'تم الربط بنجاح!': { he: 'החיבור הצליח!', en: 'Linked successfully!' },
  'جارٍ تجهيز رمز الربط…': { he: 'מכין קוד קישור…', en: 'Preparing link code…' },
  'أحد': { he: 'א׳', en: 'Sun' },
  'اثنين': { he: 'ב׳', en: 'Mon' },
  'ثلاثاء': { he: 'ג׳', en: 'Tue' },
  'أربعاء': { he: 'ד׳', en: 'Wed' },
  'خميس': { he: 'ה׳', en: 'Thu' },
  'جمعة': { he: 'ו׳', en: 'Fri' },
  'سبت': { he: 'ש׳', en: 'Sat' },
  'تعذر تحميل المجموعات': { he: 'טעינת הקבוצות נכשלה', en: "Couldn't load groups" },
  'ربط واتساب من الإعدادات': { he: 'חבר וואטסאפ בהגדרות', en: 'Connect WhatsApp in Settings' },
  'تم حفظ أوقات الدوام': { he: 'שעות הפעילות נשמרו', en: 'Working hours saved' },
  'فشل حفظ الإعدادات': { he: 'שמירת ההגדרות נכשלה', en: 'Failed to save settings' },
  'مفتوح الآن': { he: 'פתוח כעת', en: 'Open now' },
  'مغلق الآن': { he: 'סגור כעת', en: 'Closed now' },
  'مفعّل': { he: 'פעיל', en: 'Enabled' },
  'معطّل': { he: 'כבוי', en: 'Disabled' },
  'جاري الحفظ...': { he: 'שומר...', en: 'Saving...' },
  'حفظ أوقات الدوام': { he: 'שמירת שעות פעילות', en: 'Save working hours' },
  'متصل': { he: 'מחובר', en: 'Connected' },
  'غير متصل': { he: 'לא מחובר', en: 'Disconnected' },
  'جاري التحديث...': { he: 'מרענן...', en: 'Refreshing...' },
  'اختر جلسة متصلة...': { he: 'בחר חיבור פעיל...', en: 'Select a connected session...' },
};

type I18nCtx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
};

const Ctx = createContext<I18nCtx>({
  locale: 'ar',
  setLocale: () => {},
  t: (k) => k,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ar');

  useEffect(() => {
    const saved = localStorage.getItem('rabitech_locale') as Locale | null;
    if (saved === 'he' || saved === 'en' || saved === 'ar') setLocaleState(saved);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = RTL[locale] ? 'rtl' : 'ltr';
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    localStorage.setItem('rabitech_locale', l);
    setLocaleState(l);
  }, []);

  const t = useCallback(
    (key: string) => {
      if (locale === 'ar') return key;
      return D[key]?.[locale] ?? key;
    },
    [locale]
  );

  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export function useT() {
  return useContext(Ctx);
}

export const LOCALES: Array<{ code: Locale; label: string }> = [
  { code: 'ar', label: 'عربي' },
  { code: 'he', label: 'עברית' },
  { code: 'en', label: 'EN' },
];
