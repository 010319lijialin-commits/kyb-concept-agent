// 飞书群机器人消息卡片：排名摘要 + 红线核查 + 提醒 + 需要人工复核的事项。
// ALERT_WEBHOOK_KIND=feishu_card 时使用；feishu / wecom 发纯文本。

const STATE = { pass: '通过', pass_inferred: '通过·待确认', pending: '待定', borderline: '附条件', pending_adverse: '待核·有不利线索', fail: '踩红线' };
const TAG = { opportunity: '🟢 机会', threat: '🔴 威胁', info: '🟡 复核' };

export function buildCard({ runId, ranking, mc, alerts, review = [], reportUrl, simulatedPrev }) {
  const rows = ranking
    .map((r) => {
      const p = mc?.[r.id];
      const g = `${STATE[r.gates.gate_fin.state]} / ${STATE[r.gates.gate_comp.state]}`;
      return `**${r.rank}. ${r.company.short}${r.company.role === 'self' ? '（我方）' : ''}**　已证实 ${r.total} 分　资金/合规 ${g}${p ? `　前 2 概率 ${Math.round(p.pTop2 * 100)}%` : ''}`;
    })
    .join('\n');
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: rows } },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: alerts.length ? alerts.slice(0, 6).map((a) => `${TAG[a.level]}　${a.text}`).join('\n') : '与上一期相比无显著变化。',
      },
    },
  ];
  if (simulatedPrev) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '上一期为模拟基线，仅演示机制' }] });
  if (review.length) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**待人工复核 ${review.length} 项**：${review.slice(0, 5).join('；')}` } });
  }
  if (reportUrl) {
    elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看完整报告' }, type: 'primary', url: reportUrl }] });
  }
  return {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: `Meta 一代竞争力雷达 · ${runId}` }, template: alerts.some((a) => a.level === 'opportunity') ? 'green' : 'blue' },
      elements,
    },
  };
}

export function buildText(kind, text) {
  return kind === 'wecom' ? { msgtype: 'text', text: { content: text } } : { msg_type: 'text', content: { text } };
}
