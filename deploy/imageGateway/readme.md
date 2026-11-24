# OpenAI 图片网关

香港 staging 和杭州 production 的 Toonflow 后端各自配置受控 HTTPS 网关。该网关只接受 GPT Image 2.5 Sunburst 的文生图与参考图编辑。千问沿用各环境原有路由。

1. 在供应商明确支持的部署和服务范围内运行 `bun deploy/imageGateway/index.ts`。服务进程从密钥管理注入 `OPENAI_API_KEY` 与独立的 `OPENAI_IMAGE_GATEWAY_TOKEN`。令牌至少 32 字符，并与上游密钥分开管理。缺省只监听 `127.0.0.1:18875`，端口由 `OPENAI_IMAGE_GATEWAY_PORT` 覆盖。
2. 用现有 HTTPS 入口转发 `/v1/images/generations` 和 `/v1/images/edits` 到此监听地址。入口保留请求与响应的请求 ID 头。限制来源为获准的 Toonflow 后端，并保留网关自身令牌鉴权。入口请求体上限需容纳至多 20 MiB 的编码图像及 JSON，超时需覆盖网关的 180 秒上游请求。
3. 在 staging 的媒体供应商配置中启用「OpenAI 图片网关」。共享 staging 用服务器环境变量 `TOONFLOW_OPENAI_IMAGE_GATEWAY_URL`、`TOONFLOW_OPENAI_IMAGE_GATEWAY_TOKEN` 和 `TOONFLOW_OPENAI_IMAGE_GATEWAY_SOURCE_SHA256`。最后一项填写部署所用 `packages/providers/src/media/openaiImage.ts` 的 SHA-256。后端只向该版本注入网关令牌。多租户环境通过超管后台导入同一 provider，在现有模型路由和价格里启用 `gpt-image-2.5-sunburst`。OpenAI 上游密钥只留在网关，多租户供应商配置的 `apiKey` 字段存放网关令牌。 将参考图上限从 4 张升级到 16 张时，先发布并验证对应的网关，再通过供应商管理更新已保存的 `openaiImage` 源码并保留原配置和模型路由。
4. 在画布分别完成一次文生图和上传参考图编辑，并读回保存的成图。按 `taskId` 查询 Toonflow 后端的 `canvasOpenaiImageGateway` 日志，用其中的 `requestId` 对照网关 `openaiImageGateway` 日志以及 OpenAI 返回的 `upstreamRequestId`。成功后才保留启用配置。切换杭州时重新验证其路由，从杭州画布实测并独立读回同样的证据。

[OpenAI 图片 API](https://developers.openai.com/api/docs/guides/image-generation) · [OpenAI 支持地区](https://help.openai.com/en/articles/7947663-chatgpt-and-openai-api-supported-countries-and-territories)
