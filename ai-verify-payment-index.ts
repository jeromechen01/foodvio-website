// ============================================================
// 华仔爸爸商城 · ai-verify-payment Edge Function
// 路径: supabase/functions/ai-verify-payment/index.ts
// 作用: 后台核对台调用。用豆包/火山方舟(Ark) vision OCR 识别支付截图的
//       金额/时间/收款方 → 与订单 total_cents 比对 → 写回 cp_payment_records.ai_ocr_result。
//       仅做「辅助核对」，不自动改 verified、不自动发货（由后台人工点确认）。
// 鉴权: 仅管理员可调用（cp_is_admin）。
// secrets: ARK_API_KEY, ARK_VISION_ENDPOINT(推理接入点id或模型名)
// 部署: supabase functions deploy ai-verify-payment
// 备注: 金额比对是确定性算术，直接在代码里做，不调用 DeepSeek（省一次调用、结果可复现）。
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "NO_AUTH" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) 校验调用者是管理员
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: isAdmin, error: adminErr } = await userClient.rpc("cp_is_admin");
    if (adminErr) return json({ error: adminErr.message }, 400);
    if (!isAdmin) return json({ error: "FORBIDDEN_NOT_ADMIN" }, 403);

    const { paymentRecordId } = await req.json().catch(() => ({}));
    if (!paymentRecordId) return json({ error: "MISSING_PAYMENT_RECORD_ID" }, 400);

    // 2) service_role 读取支付记录 + 订单金额
    const svc = createClient(url, service);
    const { data: rec, error: recErr } = await svc
      .from("cp_payment_records")
      .select("id, order_id, proof_url, cp_orders(total_cents, order_no)")
      .eq("id", paymentRecordId)
      .single();
    if (recErr || !rec) return json({ error: "PAYMENT_RECORD_NOT_FOUND" }, 404);

    // @ts-ignore 关联返回
    const expectedCents: number = rec.cp_orders?.total_cents ?? null;

    // 3) 取图：私有桶 → 签名 URL（proof_url 存的是 cp-uploads 内路径）；若已是 http(s) 则直接用
    let imageUrl = rec.proof_url as string;
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      const { data: signed, error: signErr } = await svc.storage
        .from("cp-uploads").createSignedUrl(imageUrl, 300);
      if (signErr || !signed) return json({ error: "SIGN_URL_FAILED" }, 400);
      imageUrl = signed.signedUrl;
    }

    // 4) 调豆包/Ark vision OCR（OpenAI 兼容 /chat/completions）
    const sys = "你是支付凭证核对助手。识别这张微信或支付宝支付截图，提取：金额(元)、支付时间、收款方名称。" +
      "严格只输出 JSON，不要任何解释或 markdown：" +
      '{"amount_yuan":数字或null,"pay_time":"字符串或null","payee":"字符串或null"}。' +
      "识别不到的字段填 null，不要编造。";
    const arkResp = await fetch(`${ARK_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${Deno.env.get("ARK_API_KEY")}` },
      body: JSON.stringify({
        model: Deno.env.get("ARK_VISION_ENDPOINT"),
        messages: [{
          role: "user",
          content: [
            { type: "text", text: sys },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        }],
        temperature: 0,
      }),
    });
    if (!arkResp.ok) return json({ error: "ARK_HTTP_" + arkResp.status, detail: await arkResp.text() }, 502);
    const arkData = await arkResp.json();
    const raw = arkData?.choices?.[0]?.message?.content ?? "";

    // 5) 解析严格 JSON（容错去除可能的代码围栏）
    let parsed: { amount_yuan: number | null; pay_time: string | null; payee: string | null };
    try {
      parsed = JSON.parse(String(raw).replace(/```json|```/g, "").trim());
    } catch {
      parsed = { amount_yuan: null, pay_time: null, payee: null };
    }

    // 6) 确定性金额比对（代码做，不用 LLM）
    const ocrCents = parsed.amount_yuan == null ? null : Math.round(parsed.amount_yuan * 100);
    const matched = ocrCents != null && expectedCents != null && ocrCents === expectedCents;

    const result = {
      ...parsed,
      ocr_amount_cents: ocrCents,
      expected_cents: expectedCents,
      matched,                       // true=金额一致(仅候选，仍需人工确认)
      checked_at: new Date().toISOString(),
    };

    // 7) 写回 ai_ocr_result（不动 verified；人工在后台点确认）
    await svc.from("cp_payment_records").update({ ai_ocr_result: result }).eq("id", paymentRecordId);

    return json(result, 200);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
