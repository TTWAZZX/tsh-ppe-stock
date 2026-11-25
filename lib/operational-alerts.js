export async function reportOperationalAlert(workflows, { event, key = event, message, details = {} }) {
  const now = new Date().toISOString();
  console.warn(JSON.stringify({ event, ...details, timestamp: now }));
  try {
    const delivery = await workflows.sendToAdmins({
      topic: 'system',
      messages: [{ type: 'text', text: message }],
      eventKey: 'operations:' + key + ':' + now.slice(0, 13),
      notificationType: event,
      entityType: 'operations',
    });
    if (!delivery?.accepted) {
      console.warn(JSON.stringify({ event: 'operational_alert_delivery_unavailable', alert: event, timestamp: now }));
    }
  } catch {
    console.warn(JSON.stringify({ event: 'operational_alert_delivery_unavailable', alert: event, timestamp: now }));
  }
}

export function reportNotificationQueue(workflows, retry) {
  if (!retry.recovered && !retry.overdue) return;
  return reportOperationalAlert(workflows, {
    event: 'notification_queue_delayed',
    message: 'PPE Stock: คิว LINE มีรายการที่ต้องติดตาม กรุณาตรวจศูนย์แจ้งเตือน',
    details: { recovered: retry.recovered, overdue: retry.overdue, processed: retry.processed },
  });
}
