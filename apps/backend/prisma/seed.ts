import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding RabiTech database...');

  const organizationId = 'org_rabitech_0';
  await prisma.organization.upsert({
    where: { id: organizationId },
    update: { name: 'RabiTech Demo', slug: 'rabitech-demo', status: 'ACTIVE' },
    create: { id: organizationId, name: 'RabiTech Demo', slug: 'rabitech-demo', status: 'ACTIVE' },
  });

  const ownerEmail = (process.env.PLATFORM_OWNER_EMAIL || 'owner@rabitech.co.il').toLowerCase();
  const ownerHash = await bcrypt.hash(process.env.PLATFORM_OWNER_PASSWORD || 'owner12345', 10);
  await prisma.identity.upsert({
    where: { email: ownerEmail },
    update: { passwordHash: ownerHash, platformRole: 'OWNER' },
    create: { email: ownerEmail, passwordHash: ownerHash, platformRole: 'OWNER' },
  });

  // Zones
  await prisma.zone.createMany({
    skipDuplicates: true,
    data: [
      { id: 'kfar-qasim', nameAr: 'كفر قاسم', nameHe: 'כפר קאסם', color: '#3B82F6' },
      { id: 'kfar-bara',  nameAr: 'كفر برا',   nameHe: 'כפר ברא',  color: '#8B5CF6' },
      { id: 'jaljulia',   nameAr: 'جلجولية',   nameHe: "ג'לג'וליה",color: '#EC4899' },
      { id: 'tayibe',     nameAr: 'الطيبة',    nameHe: 'טייבה',    color: '#F59E0B' },
      { id: 'tira',       nameAr: 'الطيرة',    nameHe: 'טירה',     color: '#10B981' },
    ],
  });

  // WhatsApp Sessions — IT line is the live RabiTech office number
  const itPhone = process.env.IT_NUMBER || '972524141422';
  await prisma.whatsappSession.upsert({
    where: { organizationId_sessionName: { organizationId, sessionName: 'rabitech-demo-primary' } },
    update: { phoneNumber: itPhone, label: 'الدعم التقني', isActive: true },
    create: {
      organizationId,
      sessionName: 'rabitech-demo-primary',
      phoneNumber: itPhone,
      department: 'IT',
      label: 'الدعم التقني',
    },
  });
  const mktPhone = process.env.MARKETING_NUMBER;
  if (mktPhone && mktPhone !== itPhone) {
    await prisma.whatsappSession.upsert({
      where: { organizationId_sessionName: { organizationId, sessionName: 'rabitech-demo-marketing' } },
      update: { phoneNumber: mktPhone, label: 'التسويق', isActive: true },
      create: {
        organizationId,
        sessionName: 'rabitech-demo-marketing',
        phoneNumber: mktPhone,
        department: 'MARKETING',
        label: 'التسويق',
      },
    });
  } else {
    // Same WhatsApp line — marketing tab uses it-support session (see whatsapp-sessions.ts)
    await prisma.whatsappSession.upsert({
      where: { organizationId_sessionName: { organizationId, sessionName: 'rabitech-demo-marketing' } },
      update: { phoneNumber: mktPhone || itPhone, label: 'التسويق', isActive: true },
      create: {
        organizationId,
        sessionName: 'rabitech-demo-marketing',
        phoneNumber: mktPhone || itPhone,
        department: 'MARKETING',
        label: 'التسويق',
      },
    });
  }

  // Admin user
  const adminHash = await bcrypt.hash('admin123', 10);
  const adminIdentity = await prisma.identity.upsert({
    where: { email: 'admin@rabitech.co.il' },
    update: { passwordHash: adminHash },
    create: { email: 'admin@rabitech.co.il', passwordHash: adminHash },
  });
  await prisma.user.upsert({
    where: { organizationId_identityId: { organizationId, identityId: adminIdentity.id } },
    update: { role: 'ADMIN' },
    create: {
      organizationId,
      identityId: adminIdentity.id,
      name: 'مدير النظام',
      department: 'ADMIN',
      role: 'ADMIN',
    },
  });

  // IT users (technicians)
  const itHash = await bcrypt.hash('rabitech2026', 10);
  const itUsers = [
    { name: 'أحمد صالح',  email: 'ahmed@rabitech.co.il',  phone: '0501234567' },
    { name: 'محمد علي',   email: 'mohammed@rabitech.co.il',phone: '0502345678' },
    { name: 'يوسف كريم', email: 'yousef@rabitech.co.il',  phone: '0503456789' },
    { name: 'كمال نصر',  email: 'kamal@rabitech.co.il',   phone: '0504567890' },
  ];
  for (const u of itUsers) {
    const identity = await prisma.identity.upsert({
      where: { email: u.email },
      update: { passwordHash: itHash },
      create: { email: u.email, passwordHash: itHash },
    });
    await prisma.user.upsert({
      where: { organizationId_identityId: { organizationId, identityId: identity.id } },
      update: {},
      create: {
        organizationId,
        identityId: identity.id,
        name: u.name,
        phone: u.phone,
        department: 'IT',
      },
    });
  }

  // Marketing user
  const mktHash = await bcrypt.hash('rabitech2026', 10);
  const marketingIdentity = await prisma.identity.upsert({
    where: { email: 'marketing@rabitech.co.il' },
    update: { passwordHash: mktHash },
    create: { email: 'marketing@rabitech.co.il', passwordHash: mktHash },
  });
  await prisma.user.upsert({
    where: { organizationId_identityId: { organizationId, identityId: marketingIdentity.id } },
    update: {},
    create: {
      organizationId,
      identityId: marketingIdentity.id,
      name: 'فريق التسويق',
      department: 'MARKETING',
    },
  });

  // Message templates
  const templates = [
    {
      title: 'تذكرة عاجلة',
      category: 'AUTO_REPLY' as const,
      dept: 'IT' as const,
      sortOrder: 1,
      body: `🚨 مرحباً، تم استلام رسالتك وفتح تذكرة عاجلة *#{{ticketId}}*

نعتذر عن هذا الإزعاج. سيتواصل معك فريقنا خلال *30 دقيقة*.

RabiTech 🌐`,
    },
    {
      title: 'تذكرة دعم',
      category: 'AUTO_REPLY' as const,
      dept: 'IT' as const,
      sortOrder: 2,
      body: `مرحباً 👋 تم فتح تذكرة دعم *#{{ticketId}}*

جرب أولاً:
1️⃣ أوقف الراوتر 30 ثانية وأعد تشغيله
2️⃣ تحقق من أضواء الجهاز

إذا استمرت المشكلة سيتصل بك فريقنا خلال ساعتين.
RabiTech 🌐`,
    },
    {
      title: 'تذكرة متوسطة',
      category: 'AUTO_REPLY' as const,
      dept: 'IT' as const,
      sortOrder: 3,
      body: `مرحباً بك في دعم RabiTech 🌐

تم تسجيل مشكلتك برقم *#{{ticketId}}*

سيتواصل معك فريقنا خلال *4 ساعات*.
أوقات الدعم: الأحد–الخميس | ٨ص–٨م`,
    },
    {
      title: 'تذكرة عادية',
      category: 'AUTO_REPLY' as const,
      dept: 'IT' as const,
      sortOrder: 4,
      body: `مرحباً 😊 تم استلام طلبك *#{{ticketId}}*

سيتواصل معك فريقنا قريباً.
RabiTech 🌐`,
    },
    {
      title: 'رسالة إغلاق + تقييم',
      category: 'QUICK_REPLY' as const,
      dept: 'IT' as const,
      sortOrder: 10,
      body: `✅ تم حل تذكرتك *#{{ticketId}}*

نأمل أن الخدمة عادت بشكل طبيعي 🙏
كيف تقيّم خدمتنا؟ أرسل رقماً من 1 إلى 5`,
    },
    {
      title: 'إرسال تقني',
      category: 'QUICK_REPLY' as const,
      dept: 'IT' as const,
      sortOrder: 11,
      body: `👨‍🔧 تم إرسال التقني *{{techName}}* إليك

الوصول المتوقع: *{{eta}}*
سيتصل بك التقني قبل الوصول.`,
    },
    {
      title: 'خارج أوقات الدعم',
      category: 'OUT_OF_HOURS' as const,
      dept: 'IT' as const,
      sortOrder: 12,
      body: `مرحباً! 🌙

شكراً على تواصلك مع RabiTech.

أوقات الدعم: {{workDays}}
من {{startTime}} حتى {{endTime}}

سيتواصل معك فريقنا في أول وقت عمل. شكراً لتفهمك 🙏
RabiTech 🌐`,
    },
    {
      title: 'إعادة تشغيل الراوتر',
      category: 'QUICK_REPLY' as const,
      dept: 'IT' as const,
      sortOrder: 13,
      body: `مرحباً 👋

جرب إعادة تشغيل الراوتر:
1️⃣ افصل الكهرباء 30 ثانية
2️⃣ أعد التشغيل وانتظر دقيقتين
3️⃣ تحقق من أضواء الجهاز

إذا لم تُحل المشكلة أخبرنا وسنساعدك فوراً.`,
    },
    {
      title: 'إشعار عطل منطقة',
      category: 'OUTAGE' as const,
      dept: 'IT' as const,
      sortOrder: 20,
      body: `⚠️ إشعار عطل — RabiTech

عزيزنا مشترك منطقة *{{zone}}*،
يوجد عطل مؤقت في الشبكة يؤثر على منطقتكم.

فريقنا يعمل على الحل.
الوقت المتوقع للإصلاح: *{{eta}}*

نعتذر عن الإزعاج 🙏
RabiTech`,
    },
    {
      title: 'عرض جديد',
      category: 'CAMPAIGN' as const,
      dept: 'MARKETING' as const,
      sortOrder: 30,
      body: `🎉 عرض جديد من RabiTech!

📦 *{{plan}}*
⚡ السرعة: {{speed}}
💰 السعر: {{price}} ₪/شهر

للاشتراك أو الاستفسار رد على هذه الرسالة 📞`,
    },
    {
      title: 'ترحيب مشترك جديد',
      category: 'CAMPAIGN' as const,
      dept: 'MARKETING' as const,
      sortOrder: 31,
      body: `مرحباً بك في RabiTech 🌐

يسعدنا انضمامك لعائلة RabiTech!
لأي استفسار أو دعم فني، رد على هذه الرسالة وسنساعدك فوراً.`,
    },
    {
      title: 'متابعة عميل',
      category: 'QUICK_REPLY' as const,
      dept: 'MARKETING' as const,
      sortOrder: 40,
      body: `مرحباً 👋

شكراً لتواصلك مع RabiTech.
كيف يمكننا مساعدتك اليوم؟`,
    },
  ];

  for (const t of templates) {
    await prisma.messageTemplate.upsert({
      where: { id: `seed-${t.sortOrder}` },
      update: { title: t.title, body: t.body, category: t.category, dept: t.dept, sortOrder: t.sortOrder },
      create: { id: `seed-${t.sortOrder}`, organizationId, ...t },
    });
  }

  await prisma.messageTemplate.upsert({
    where: { id: 'seed-welcome-start' },
    update: {
      title: 'ترحيب فتح محادثة',
      body: 'مرحبا، بحكي معك من شركة RabiTech 🌐\nكيف بقدر أساعدك؟',
      category: 'AUTO_REPLY',
      dept: 'IT',
      sortOrder: 0,
      isActive: true,
    },
    create: {
      id: 'seed-welcome-start',
      organizationId,
      title: 'ترحيب فتح محادثة',
      category: 'AUTO_REPLY',
      dept: 'IT',
      sortOrder: 0,
      body: 'مرحبا، بحكي معك من شركة RabiTech 🌐\nكيف بقدر أساعدك؟',
    },
  });

  const oohTemplate = await prisma.messageTemplate.findUnique({ where: { id: 'seed-12' } });
  await prisma.workingHours.upsert({
    where: { id: 'default' },
    update: { outOfHoursTemplateId: oohTemplate?.id },
    create: {
      id: 'default',
      enabled: true,
      timezone: 'Asia/Jerusalem',
      workDays: [0, 1, 2, 3, 4],
      startTime: '08:00',
      endTime: '20:00',
      outOfHoursTemplateId: oohTemplate?.id,
    },
  });

  console.log('Seed complete!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
