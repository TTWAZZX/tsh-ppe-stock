const THEMES = {
  info: { accent: '#0F766E', soft: '#ECFDF5', text: '#065F46' },
  pending: { accent: '#D97706', soft: '#FFFBEB', text: '#92400E' },
  success: { accent: '#059669', soft: '#ECFDF5', text: '#065F46' },
  warning: { accent: '#EA580C', soft: '#FFF7ED', text: '#9A3412' },
  danger: { accent: '#DC2626', soft: '#FEF2F2', text: '#991B1B' },
  partial: { accent: '#7C3AED', soft: '#F5F3FF', text: '#5B21B6' },
};

function clean(value, maxLength = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isSafeUri(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function detailRow(label, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      { type: 'text', text: clean(label, 40) || '-', color: '#64748B', size: 'sm', flex: 0 },
      { type: 'text', text: clean(value, 300) || '-', color: '#0F172A', size: 'sm', weight: 'bold', align: 'end', wrap: true, flex: 1 },
    ],
  };
}

function itemSection(items) {
  const normalized = (Array.isArray(items) ? items : [])
    .map(item => {
      if (item && typeof item === 'object') {
        return {
          text: clean(item.text || item.name, 240).replace(/^•\s*/, ''),
          imageUrl: isSafeUri(item.imageUrl) ? String(item.imageUrl) : '',
        };
      }
      return { text: clean(item, 240).replace(/^•\s*/, ''), imageUrl: '' };
    })
    .filter(item => item.text);
  if (!normalized.length) return [];

  const visible = normalized.slice(0, 6);
  const remainder = normalized.length - visible.length;
  return [
    { type: 'separator', margin: 'lg', color: '#E2E8F0' },
    {
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'รายการอุปกรณ์', size: 'xs', color: '#64748B', weight: 'bold' },
        ...visible.map(item => ({
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          alignItems: 'center',
          contents: [
            ...(item.imageUrl ? [{
              type: 'image',
              url: item.imageUrl,
              size: 'sm',
              aspectRatio: '1:1',
              aspectMode: 'cover',
              flex: 0,
            }] : [{ type: 'text', text: '•', size: 'sm', color: '#14B8A6', flex: 0 }]),
            { type: 'text', text: item.text, size: 'sm', color: '#334155', wrap: true, flex: 1 },
          ],
        })),
        ...(remainder > 0 ? [{ type: 'text', text: `และอีก ${remainder} รายการ`, size: 'xs', color: '#64748B', style: 'italic' }] : []),
      ],
    },
  ];
}

/**
 * สร้าง LINE Flex Message แบบมาตรฐานของระบบ PPE Stock
 * ใช้เฉพาะ component/property ที่รองรับทั่วไปใน Flex Message bubble
 */
export function createPpeFlexMessage({
  eyebrow = 'PPE STOCK',
  title,
  status,
  summary = '',
  fields = [],
  items = [],
  theme = 'info',
  actionLabel = 'เปิดดูรายละเอียด',
  actionUrl = '',
  desktopUrl = '',
  heroImageUrl = '',
  altText = '',
} = {}) {
  const palette = THEMES[theme] || THEMES.info;
  const safeTitle = clean(title, 120) || 'การแจ้งเตือนจาก PPE Stock';
  const safeStatus = clean(status, 80) || 'แจ้งเตือน';
  const safeSummary = clean(summary, 500);
  const normalizedFields = (Array.isArray(fields) ? fields : [])
    .map(field => ({ label: clean(field?.label, 40), value: clean(field?.value, 300) }))
    .filter(field => field.label && field.value);
  const validActionUrl = isSafeUri(actionUrl) ? String(actionUrl) : '';
  const validDesktopUrl = isSafeUri(desktopUrl) ? String(desktopUrl) : validActionUrl;
  const validHeroImageUrl = isSafeUri(heroImageUrl) ? String(heroImageUrl) : '';
  const fallbackAlt = `${safeTitle}: ${safeStatus}`;

  const bodyContents = [
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: palette.soft,
      cornerRadius: 'md',
      paddingAll: '12px',
      contents: [
        { type: 'text', text: safeStatus, color: palette.text, size: 'sm', weight: 'bold', wrap: true },
        ...(safeSummary ? [{ type: 'text', text: safeSummary, color: '#475569', size: 'xs', margin: 'sm', wrap: true }] : []),
      ],
    },
    ...(normalizedFields.length ? [{
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      spacing: 'md',
      contents: normalizedFields.map(field => detailRow(field.label, field.value)),
    }] : []),
    ...itemSection(items),
  ];

  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: palette.accent,
      paddingAll: '20px',
      spacing: 'sm',
      contents: [
        { type: 'text', text: clean(eyebrow, 50).toUpperCase(), color: '#CCFBF1', size: 'xs', weight: 'bold' },
        { type: 'text', text: safeTitle, color: '#FFFFFF', size: 'xl', weight: 'bold', wrap: true },
      ],
    },
    ...(validHeroImageUrl ? {
      hero: {
        type: 'image',
        url: validHeroImageUrl,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'fit',
        ...(validActionUrl ? { action: { type: 'uri', uri: validActionUrl } } : {}),
      },
    } : {}),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      contents: bodyContents,
    },
  };

  if (validActionUrl) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      paddingTop: '0px',
      contents: [{
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: palette.accent,
        action: {
          type: 'uri',
          label: clean(actionLabel, 20) || 'เปิดดูรายละเอียด',
          uri: validActionUrl,
          altUri: { desktop: validDesktopUrl },
        },
      }],
    };
  }

  return {
    type: 'flex',
    altText: clean(altText, 1500) || fallbackAlt,
    contents: bubble,
  };
}

export const lineFlexInternals = { clean, isSafeUri, THEMES };
