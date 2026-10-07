// 模型调用：一个 OpenAI 兼容接口 + Azure OpenAI。换国产模型（DeepSeek、通义千问等）只改环境变量。
//
//   LLM_PROVIDER=openai-compatible  LLM_BASE_URL=...  LLM_API_KEY=...
//   LLM_PROVIDER=azure              AZURE_OPENAI_ENDPOINT=...  AZURE_OPENAI_API_KEY=...  AZURE_OPENAI_API_VERSION=...
//   CHEAP_MODEL=...   检索抽取用（Azure 下填部署名）
//   STRONG_MODEL=...  综合判分用

export const ledger = { cheap: { in: 0, out: 0, calls: 0 }, strong: { in: 0, out: 0, calls: 0 }, search: 0 };

export function modelFor(tier) {
  const name = tier === 'strong' ? process.env.STRONG_MODEL : process.env.CHEAP_MODEL;
  if (!name) throw new Error(`没有配置 ${tier === 'strong' ? 'STRONG_MODEL' : 'CHEAP_MODEL'}，见 .env.example`);
  return name;
}

function endpoint(model) {
  if ((process.env.LLM_PROVIDER || 'openai-compatible') === 'azure') {
    const base = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
    const ver = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
    return {
      url: `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${ver}`,
      headers: { 'api-key': process.env.AZURE_OPENAI_API_KEY || '' },
      body: {},
    };
  }
  const base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  return {
    url: `${base}/chat/completions`,
    headers: { Authorization: `Bearer ${process.env.LLM_API_KEY || ''}` },
    body: { model },
  };
}

export async function chatJSON(tier, system, user) {
  const model = modelFor(tier);
  const ep = endpoint(model);
  const resp = await fetch(ep.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ep.headers },
    body: JSON.stringify({
      ...ep.body,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`${tier} 模型 ${resp.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  ledger[tier].in += data.usage?.prompt_tokens ?? 0;
  ledger[tier].out += data.usage?.completion_tokens ?? 0;
  ledger[tier].calls += 1;
  const content = data.choices?.[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${tier} 模型没有返回合法 JSON：${content.slice(0, 200)}`);
  }
}
