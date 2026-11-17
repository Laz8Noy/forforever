// DeepSeek 官方口径估算：中文字符约 0.6 token，其他字符约 0.3 token，乘 1.1 安全系数
const CJK = /[⺀-鿿豈-﫿︰-﹏　-〿＀-￯]/;

export function estimateTokens(text: string, calibration = 1): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil((cjk * 0.6 + other * 0.3) * 1.1 * calibration);
}

export function estimateMessagesTokens(
  messages: { content: string }[],
  calibration = 1,
): number {
  let sum = 0;
  for (const m of messages) sum += estimateTokens(m.content, calibration) + 4;
  return sum;
}