/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface WhatsAppProxyBody {
  to?: string;
  message?: string;
  eventType?: string;
  instanceName?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolvedWhatsAppEnv {
  configured: boolean;
  hasApiToken: boolean;
  provider: 'EVOLUTION' | 'META_CLOUD' | 'WEBHOOK';
  baseUrl: string;
  directSendUrl: string;
  apiToken: string;
  defaultInstanceName: string;
}

export interface GatewayStatusResponse {
  configured: boolean;
  hasApiToken: boolean;
  provider: 'EVOLUTION' | 'META_CLOUD' | 'WEBHOOK';
  connected: boolean;
  state: 'open' | 'connecting' | 'close' | 'missing' | 'unconfigured' | 'ready';
  instanceName: string;
  profileName?: string;
  ownerNumber?: string;
  message?: string;
}

export interface GatewayConnectResponse {
  success: boolean;
  connected: boolean;
  state: string;
  instanceName: string;
  qrCodeBase64?: string;
  pairingCode?: string;
  profileName?: string;
  ownerNumber?: string;
  error?: string;
}

const UPSTREAM_TIMEOUT_MS = 45000;
const JID_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Limpa artefatos de cópia/colagem (como links Markdown `[url](url)` ou `url](url`),
 * aspas extras, espaços e barras finais da variável `WHATSAPP_API_URL`.
 */
export function normalizeProviderUrl(raw: string | undefined | null): string {
  if (!raw) return '';

  let cleaned = String(raw)
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();

  if (!cleaned) return '';

  const markdownMatch = cleaned.match(/https?:\/\/[^\s\]"')]+/i);
  if (markdownMatch && markdownMatch[0]) {
    cleaned = markdownMatch[0];
  }

  return cleaned.replace(/\/+$/, '');
}

/**
 * Remove TODOS os caracteres não numéricos (parênteses, traços, espaços, '+')
 * e garante o DDI 55 (Brasil) seguido de DDD + número (`55119XXXXXXXX`).
 */
export function sanitizePhoneForProvider(raw: string | undefined | null): string {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';

  if ((digits.length === 11 || digits.length === 12) && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    return `55${digits}`;
  }

  return digits;
}

function sanitizeInstanceName(raw: string | undefined | null, fallback = 'techreserve'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || fallback;
}

/**
 * Resolve e normaliza a configuração de ambiente do provedor WhatsApp.
 */
export function resolveWhatsAppConfig(overrideInstanceName?: string): ResolvedWhatsAppEnv {
  const rawUrl = process.env.WHATSAPP_API_URL || process.env.VITE_WHATSAPP_API_URL || '';
  const cleanUrl = normalizeProviderUrl(rawUrl);
  const apiToken = String(process.env.WHATSAPP_API_TOKEN || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '');

  const rawProvider = String(
    process.env.WHATSAPP_PROVIDER || process.env.VITE_WHATSAPP_PROVIDER || ''
  )
    .trim()
    .toUpperCase();

  let provider: 'EVOLUTION' | 'META_CLOUD' | 'WEBHOOK' = 'WEBHOOK';
  if (
    rawProvider === 'EVOLUTION' ||
    /evolution/i.test(cleanUrl) ||
    /\/message\/sendText\//i.test(cleanUrl)
  ) {
    provider = 'EVOLUTION';
  } else if (rawProvider === 'META_CLOUD' || /graph\.facebook\.com/i.test(cleanUrl)) {
    provider = 'META_CLOUD';
  }

  let baseUrl = cleanUrl;
  let defaultInstanceName = sanitizeInstanceName(
    overrideInstanceName || process.env.WHATSAPP_INSTANCE,
    'techreserve'
  );
  let directSendUrl = cleanUrl;

  if (provider === 'EVOLUTION' && cleanUrl) {
    const sendTextMatch = cleanUrl.match(/^(https?:\/\/.+?)\/message\/sendText\/([^/?#]+)/i);
    if (sendTextMatch) {
      baseUrl = sendTextMatch[1].replace(/\/+$/, '');
      if (!overrideInstanceName && !process.env.WHATSAPP_INSTANCE) {
        defaultInstanceName = sanitizeInstanceName(decodeURIComponent(sendTextMatch[2]));
      }
      directSendUrl = `${baseUrl}/message/sendText/${encodeURIComponent(defaultInstanceName)}`;
    } else {
      baseUrl = cleanUrl.replace(/\/(manager|docs|swagger)\/?$/i, '');
      directSendUrl = `${baseUrl}/message/sendText/${encodeURIComponent(defaultInstanceName)}`;
    }
  }

  return {
    configured: Boolean(cleanUrl),
    hasApiToken: Boolean(apiToken),
    provider,
    baseUrl,
    directSendUrl,
    apiToken,
    defaultInstanceName,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = UPSTREAM_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Monta cabeçalhos oficiais da Evolution API (`apikey` + `Content-Type: application/json`).
 */
function buildEvolutionHeaders(apiToken: string, json = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) {
    headers['Content-Type'] = 'application/json';
  }
  if (apiToken) {
    headers.apikey = apiToken;
  }
  return headers;
}

interface ParsedEvolutionInstance {
  name: string;
  state: 'open' | 'connecting' | 'close';
  profileName?: string;
  ownerNumber?: string;
}

function parseEvolutionInstancesList(rawData: unknown): ParsedEvolutionInstance[] {
  const rawList = Array.isArray(rawData)
    ? rawData
    : rawData && typeof rawData === 'object' && Array.isArray((rawData as any).instances)
    ? (rawData as any).instances
    : rawData && typeof rawData === 'object' && Array.isArray((rawData as any).data)
    ? (rawData as any).data
    : [];

  const parsed: ParsedEvolutionInstance[] = [];

  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, any>;
    const inst = obj.instance && typeof obj.instance === 'object' ? obj.instance : obj;
    const name = String(inst.instanceName || inst.name || '').trim();
    if (!name) continue;

    const rawState = String(
      inst.state || inst.connectionStatus || inst.status || 'close'
    ).toLowerCase();
    const state: 'open' | 'connecting' | 'close' =
      rawState === 'open'
        ? 'open'
        : rawState === 'connecting' || rawState === 'created'
        ? 'connecting'
        : 'close';

    const rawOwner = String(inst.owner || inst.ownerJid || '').trim();
    const ownerNumber = rawOwner ? rawOwner.split('@')[0].replace(/\D/g, '') : undefined;
    const profileName = inst.profileName ? String(inst.profileName).trim() : undefined;

    parsed.push({ name, state, profileName, ownerNumber });
  }

  return parsed;
}

/**
 * Consulta o estado atual da integração WhatsApp (incluindo estado real da instância na Evolution API).
 */
export async function getGatewayStatus(
  requestedInstanceName?: string
): Promise<GatewayStatusResponse> {
  const cfg = resolveWhatsAppConfig(requestedInstanceName);

  if (!cfg.configured) {
    return {
      configured: false,
      hasApiToken: cfg.hasApiToken,
      provider: cfg.provider,
      connected: false,
      state: 'unconfigured',
      instanceName: cfg.defaultInstanceName,
      message: 'Variável WHATSAPP_API_URL não configurada no servidor.',
    };
  }

  if (cfg.provider !== 'EVOLUTION') {
    return {
      configured: true,
      hasApiToken: cfg.hasApiToken,
      provider: cfg.provider,
      connected: true,
      state: 'ready',
      instanceName: 'webhook',
    };
  }

  try {
    const listRes = await fetchWithTimeout(
      `${cfg.baseUrl}/instance/fetchInstances`,
      {
        method: 'GET',
        headers: buildEvolutionHeaders(cfg.apiToken, false),
      },
      UPSTREAM_TIMEOUT_MS
    );

    if (listRes.ok) {
      const listData = await listRes.json().catch(() => []);
      const instances = parseEvolutionInstancesList(listData);

      const openInstance =
        instances.find(
          (i) => i.name.toLowerCase() === cfg.defaultInstanceName.toLowerCase() && i.state === 'open'
        ) || instances.find((i) => i.state === 'open');

      if (openInstance) {
        return {
          configured: true,
          hasApiToken: cfg.hasApiToken,
          provider: 'EVOLUTION',
          connected: true,
          state: 'open',
          instanceName: openInstance.name,
          profileName: openInstance.profileName,
          ownerNumber: openInstance.ownerNumber,
        };
      }

      const targetInst =
        instances.find(
          (i) => i.name.toLowerCase() === cfg.defaultInstanceName.toLowerCase()
        ) || instances[0];

      if (targetInst) {
        const stateRes = await fetchWithTimeout(
          `${cfg.baseUrl}/instance/connectionState/${encodeURIComponent(targetInst.name)}`,
          {
            method: 'GET',
            headers: buildEvolutionHeaders(cfg.apiToken, false),
          },
          15000
        ).catch(() => null);

        if (stateRes && stateRes.ok) {
          const stateJson = (await stateRes.json().catch(() => ({}))) as Record<string, any>;
          const liveState = String(
            stateJson?.instance?.state || stateJson?.state || targetInst.state
          ).toLowerCase();

          if (liveState === 'open') {
            return {
              configured: true,
              hasApiToken: cfg.hasApiToken,
              provider: 'EVOLUTION',
              connected: true,
              state: 'open',
              instanceName: targetInst.name,
              profileName: targetInst.profileName,
              ownerNumber: targetInst.ownerNumber,
            };
          }

          return {
            configured: true,
            hasApiToken: cfg.hasApiToken,
            provider: 'EVOLUTION',
            connected: false,
            state: liveState === 'connecting' ? 'connecting' : 'close',
            instanceName: targetInst.name,
          };
        }

        return {
          configured: true,
          hasApiToken: cfg.hasApiToken,
          provider: 'EVOLUTION',
          connected: false,
          state: targetInst.state,
          instanceName: targetInst.name,
        };
      }
    }

    // Fallback: consulta direta em `/instance/connectionState/{instanceName}` (cobre tokens de instância)
    const directStateRes = await fetchWithTimeout(
      `${cfg.baseUrl}/instance/connectionState/${encodeURIComponent(cfg.defaultInstanceName)}`,
      {
        method: 'GET',
        headers: buildEvolutionHeaders(cfg.apiToken, false),
      },
      12000
    ).catch(() => null);

    if (directStateRes && directStateRes.ok) {
      const stateJson = (await directStateRes.json().catch(() => ({}))) as Record<string, any>;
      const liveState = String(
        stateJson?.instance?.state || stateJson?.state || 'close'
      ).toLowerCase();

      return {
        configured: true,
        hasApiToken: cfg.hasApiToken,
        provider: 'EVOLUTION',
        connected: liveState === 'open',
        state: liveState === 'open' ? 'open' : liveState === 'connecting' ? 'connecting' : 'close',
        instanceName: cfg.defaultInstanceName,
      };
    }

    return {
      configured: true,
      hasApiToken: cfg.hasApiToken,
      provider: 'EVOLUTION',
      connected: false,
      state: 'missing',
      instanceName: cfg.defaultInstanceName,
    };
  } catch (err) {
    return {
      configured: true,
      hasApiToken: cfg.hasApiToken,
      provider: 'EVOLUTION',
      connected: false,
      state: 'close',
      instanceName: cfg.defaultInstanceName,
      message:
        err instanceof Error
          ? `Servidor WhatsApp iniciando ou indisponível: ${err.message}`
          : 'Servidor WhatsApp indisponível no momento.',
    };
  }
}

/**
 * Cria (se necessário) e obtém o QR Code ou Código de Pareamento da instância Evolution API.
 */
export async function connectGatewayInstance(options?: {
  phone?: string;
  forceRecreate?: boolean;
  instanceName?: string;
}): Promise<GatewayConnectResponse> {
  const cfg = resolveWhatsAppConfig(options?.instanceName);

  if (!cfg.configured) {
    return {
      success: false,
      connected: false,
      state: 'unconfigured',
      instanceName: cfg.defaultInstanceName,
      error: 'WHATSAPP_API_URL não está configurada nas variáveis de ambiente do servidor.',
    };
  }

  if (cfg.provider !== 'EVOLUTION') {
    return {
      success: true,
      connected: true,
      state: 'ready',
      instanceName: 'webhook',
    };
  }

  const instanceName = cfg.defaultInstanceName;
  const sanitizedPairingPhone = options?.phone
    ? sanitizePhoneForProvider(options.phone)
    : '';

  try {
    const currentStatus = await getGatewayStatus(instanceName);
    if (currentStatus.connected && currentStatus.state === 'open' && !options?.forceRecreate) {
      return {
        success: true,
        connected: true,
        state: 'open',
        instanceName: currentStatus.instanceName,
        profileName: currentStatus.profileName,
        ownerNumber: currentStatus.ownerNumber,
      };
    }

    if (options?.forceRecreate && currentStatus.state !== 'missing') {
      await fetchWithTimeout(
        `${cfg.baseUrl}/instance/logout/${encodeURIComponent(instanceName)}`,
        { method: 'DELETE', headers: buildEvolutionHeaders(cfg.apiToken, false) },
        15000
      ).catch(() => null);

      await fetchWithTimeout(
        `${cfg.baseUrl}/instance/delete/${encodeURIComponent(instanceName)}`,
        { method: 'DELETE', headers: buildEvolutionHeaders(cfg.apiToken, false) },
        15000
      ).catch(() => null);
    }

    if (currentStatus.state === 'missing' || options?.forceRecreate) {
      const createBody: Record<string, unknown> = {
        instanceName,
        qrcode: true,
        ...(sanitizedPairingPhone ? { number: sanitizedPairingPhone } : {}),
      };

      const createRes = await fetchWithTimeout(
        `${cfg.baseUrl}/instance/create`,
        {
          method: 'POST',
          headers: buildEvolutionHeaders(cfg.apiToken, true),
          body: JSON.stringify(createBody),
        },
        UPSTREAM_TIMEOUT_MS
      );

      const createJson = (await createRes.json().catch(() => ({}))) as Record<string, any>;
      const qrFromCreate = createJson?.qrcode?.base64 || createJson?.base64;
      const pairingFromCreate =
        createJson?.qrcode?.pairingCode || createJson?.pairingCode || undefined;

      if (createRes.ok && (qrFromCreate || pairingFromCreate)) {
        return {
          success: true,
          connected: false,
          state: 'connecting',
          instanceName,
          qrCodeBase64: qrFromCreate,
          pairingCode: pairingFromCreate,
        };
      }
    }

    const querySuffix = sanitizedPairingPhone
      ? `?number=${encodeURIComponent(sanitizedPairingPhone)}`
      : '';
    const connectRes = await fetchWithTimeout(
      `${cfg.baseUrl}/instance/connect/${encodeURIComponent(instanceName)}${querySuffix}`,
      {
        method: 'GET',
        headers: buildEvolutionHeaders(cfg.apiToken, false),
      },
      UPSTREAM_TIMEOUT_MS
    );

    const connectJson = (await connectRes.json().catch(() => ({}))) as Record<string, any>;

    if (connectJson?.instance?.state === 'open' || connectJson?.state === 'open') {
      return {
        success: true,
        connected: true,
        state: 'open',
        instanceName,
      };
    }

    const qrBase64 = connectJson?.base64 || connectJson?.qrcode?.base64;
    const pairingCode = connectJson?.pairingCode || connectJson?.qrcode?.pairingCode;

    if (!qrBase64 && !pairingCode && !options?.forceRecreate) {
      return connectGatewayInstance({
        phone: options?.phone,
        instanceName,
        forceRecreate: true,
      });
    }

    if (!connectRes.ok && !qrBase64 && !pairingCode) {
      return {
        success: false,
        connected: false,
        state: 'close',
        instanceName,
        error: `Falha ao gerar QR Code na Evolution API (HTTP ${connectRes.status}).`,
      };
    }

    return {
      success: true,
      connected: false,
      state: 'connecting',
      instanceName,
      qrCodeBase64: qrBase64,
      pairingCode: pairingCode || undefined,
    };
  } catch (err) {
    return {
      success: false,
      connected: false,
      state: 'close',
      instanceName,
      error:
        err instanceof Error
          ? err.message
          : 'Erro de comunicação ao gerar QR Code do Gateway WhatsApp.',
    };
  }
}

/**
 * Desconecta e remove a sessão atual da instância na Evolution API.
 */
export async function disconnectGatewayInstance(
  requestedInstanceName?: string
): Promise<{
  success: boolean;
  message: string;
}> {
  const cfg = resolveWhatsAppConfig(requestedInstanceName);
  if (!cfg.configured || cfg.provider !== 'EVOLUTION') {
    return { success: true, message: 'Sessão encerrada.' };
  }

  const status = await getGatewayStatus(requestedInstanceName);
  const targetName = status.instanceName || cfg.defaultInstanceName;

  try {
    await fetchWithTimeout(
      `${cfg.baseUrl}/instance/logout/${encodeURIComponent(targetName)}`,
      { method: 'DELETE', headers: buildEvolutionHeaders(cfg.apiToken, false) },
      15000
    ).catch(() => null);

    await fetchWithTimeout(
      `${cfg.baseUrl}/instance/delete/${encodeURIComponent(targetName)}`,
      { method: 'DELETE', headers: buildEvolutionHeaders(cfg.apiToken, false) },
      15000
    ).catch(() => null);

    return {
      success: true,
      message: `Instância ${targetName} desconectada com sucesso.`,
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Erro ao desconectar instância WhatsApp.',
    };
  }
}

/**
 * Resolve o JID / número exato registrado no WhatsApp para telefones móveis brasileiros,
 * tratando automaticamente contas antigas registradas sem o 9º dígito (ex.: DDDs 16, 19, etc.).
 */
async function resolveBrazilianEvolutionTarget(
  baseUrl: string,
  apiToken: string,
  instanceName: string,
  sanitizedTo: string
): Promise<string> {
  const candidates = [sanitizedTo];
  if (/^55[1-9]{2}9\d{8}$/.test(sanitizedTo)) {
    const withoutNinthDigit = `${sanitizedTo.slice(0, 4)}${sanitizedTo.slice(5)}`;
    candidates.push(withoutNinthDigit);
  }

  try {
    const checkRes = await fetchWithTimeout(
      `${baseUrl}/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`,
      {
        method: 'POST',
        headers: buildEvolutionHeaders(apiToken, true),
        body: JSON.stringify({ numbers: candidates }),
      },
      JID_LOOKUP_TIMEOUT_MS
    );

    if (!checkRes.ok) return sanitizedTo;

    const results = await checkRes.json().catch(() => null);
    if (Array.isArray(results)) {
      const validEntry = results.find(
        (item) => item && (item.exists === true || item.numberExists === true) && item.jid
      );
      if (validEntry?.jid) {
        return String(validEntry.jid).split('@')[0].replace(/\D/g, '') || sanitizedTo;
      }
    }
  } catch {
    // Em caso de indisponibilidade do endpoint auxiliar, utiliza o número sanitizado padrão
  }

  return sanitizedTo;
}

/**
 * Executa a chamada direta a `POST {baseUrl}/message/sendText/{instance}` com compatibilidade
 * automática entre Evolution API v1 (`textMessage.text`) e Evolution API v2 (`text`).
 */
async function sendEvolutionTextMessage(params: {
  baseUrl: string;
  apiToken: string;
  instanceName: string;
  targetNumber: string;
  message: string;
}): Promise<{
  ok: boolean;
  status: number;
  endpoint: string;
  responseText: string;
}> {
  const { baseUrl, apiToken, instanceName, targetNumber, message } = params;
  const endpoint = `${baseUrl}/message/sendText/${encodeURIComponent(instanceName)}`;
  const headers = buildEvolutionHeaders(apiToken, true);

  // 1. Formato nativo Evolution API v1.8.x (`textMessage.text`)
  let upstreamResponse = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        number: targetNumber,
        options: {
          delay: 300,
          presence: 'composing',
          linkPreview: false,
        },
        textMessage: {
          text: message,
        },
      }),
    },
    UPSTREAM_TIMEOUT_MS
  );

  let responseText = await upstreamResponse.text();

  // 2. Fallback automático para Evolution API v2 (`{ number, text, delay, linkPreview }`) em caso de HTTP 400
  if (!upstreamResponse.ok && upstreamResponse.status === 400) {
    const v2Response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          number: targetNumber,
          text: message,
          delay: 300,
          linkPreview: false,
        }),
      },
      UPSTREAM_TIMEOUT_MS
    );
    upstreamResponse = v2Response;
    responseText = await v2Response.text();
  }

  return {
    ok: upstreamResponse.ok,
    status: upstreamResponse.status,
    endpoint,
    responseText,
  };
}

/**
 * Processa o envio real da mensagem via Evolution API (`/message/sendText/{instance}`), Meta Cloud API ou Webhook HTTP.
 */
export async function dispatchWhatsAppMessage(body: WhatsAppProxyBody): Promise<{
  httpStatus: number;
  payload: Record<string, unknown>;
}> {
  const sanitizedTo = sanitizePhoneForProvider(body.to || '');
  const message = String(body.message || '').trim();
  const eventType = String(body.eventType || 'GENERIC_NOTIFICATION').trim();
  const timestamp = Date.now();

  if (!sanitizedTo || sanitizedTo.length < 12 || sanitizedTo.length > 15) {
    console.error('[WhatsApp Gateway][Erro] Número de destino inválido após sanitização:', {
      rawTo: body.to,
      sanitizedTo,
      eventType,
    });
    return {
      httpStatus: 400,
      payload: {
        success: false,
        delivered: false,
        to: sanitizedTo,
        error: `Número de telefone inválido para envio via WhatsApp (esperado DDI+DDD+Número, recebido: "${sanitizedTo || 'vazio'}").`,
      },
    };
  }

  if (!message || message.length > 4096) {
    return {
      httpStatus: 400,
      payload: {
        success: false,
        delivered: false,
        error: 'Conteúdo da mensagem ausente ou acima do limite permitido.',
      },
    };
  }

  const cfg = resolveWhatsAppConfig(body.instanceName);

  if (!cfg.configured) {
    console.error('[WhatsApp Gateway][Aviso] WHATSAPP_API_URL não configurada no servidor.', {
      eventType,
      to: sanitizedTo,
    });
    return {
      httpStatus: 200,
      payload: {
        success: true,
        delivered: false,
        mode: 'SIMULATED_NO_WEBHOOK_URL',
        provider: cfg.provider,
        to: sanitizedTo,
        eventType,
        timestamp,
      },
    };
  }

  try {
    if (cfg.provider === 'EVOLUTION') {
      let activeInstance = cfg.defaultInstanceName;
      const targetNumber = await resolveBrazilianEvolutionTarget(
        cfg.baseUrl,
        cfg.apiToken,
        activeInstance,
        sanitizedTo
      );

      console.log('[WhatsApp Gateway][Disparando Evolution API]', {
        eventType,
        instance: activeInstance,
        endpoint: `${cfg.baseUrl}/message/sendText/${encodeURIComponent(activeInstance)}`,
        to: targetNumber,
      });

      let attempt = await sendEvolutionTextMessage({
        baseUrl: cfg.baseUrl,
        apiToken: cfg.apiToken,
        instanceName: activeInstance,
        targetNumber,
        message,
      });

      // Se a instância solicitada retornou 404, busca automaticamente uma instância ativa na Evolution API e reenvia
      if (!attempt.ok && attempt.status === 404) {
        const listRes = await fetchWithTimeout(
          `${cfg.baseUrl}/instance/fetchInstances`,
          {
            method: 'GET',
            headers: buildEvolutionHeaders(cfg.apiToken, false),
          },
          12000
        ).catch(() => null);

        if (listRes && listRes.ok) {
          const listJson = await listRes.json().catch(() => []);
          const instances = parseEvolutionInstancesList(listJson);
          const fallbackInst =
            instances.find(
              (i) => i.name.toLowerCase() === activeInstance.toLowerCase()
            ) ||
            instances.find((i) => i.state === 'open') ||
            instances[0];

          if (fallbackInst && fallbackInst.name !== activeInstance) {
            console.log(
              `[WhatsApp Gateway] Instância "${activeInstance}" não encontrada (404). Redirecionando envio para instância "${fallbackInst.name}".`
            );
            activeInstance = fallbackInst.name;
            const resolvedTarget = await resolveBrazilianEvolutionTarget(
              cfg.baseUrl,
              cfg.apiToken,
              activeInstance,
              sanitizedTo
            );
            attempt = await sendEvolutionTextMessage({
              baseUrl: cfg.baseUrl,
              apiToken: cfg.apiToken,
              instanceName: activeInstance,
              targetNumber: resolvedTarget,
              message,
            });
          }
        }
      }

      if (!attempt.ok) {
        const isNotConnectedHint =
          attempt.status === 404 ||
          /not\s*exist|closed|connection|qrcode|not\s*connected/i.test(attempt.responseText);

        console.error('[WhatsApp Gateway][Erro Evolution API]', {
          eventType,
          endpoint: attempt.endpoint,
          httpStatus: attempt.status,
          to: targetNumber,
          response: attempt.responseText.slice(0, 400),
        });

        return {
          httpStatus: attempt.status === 401 || attempt.status === 403 ? attempt.status : 502,
          payload: {
            success: false,
            delivered: false,
            needsQrConnection: isNotConnectedHint,
            provider: 'EVOLUTION',
            instanceName: activeInstance,
            endpoint: attempt.endpoint,
            status: attempt.status,
            to: targetNumber,
            error:
              attempt.status === 401 || attempt.status === 403
                ? `Falha de autenticação na Evolution API (HTTP ${attempt.status} Unauthorized). Verifique WHATSAPP_API_TOKEN.`
                : attempt.status === 404
                ? `Instância "${activeInstance}" não encontrada na Evolution API (HTTP 404 em /message/sendText/${activeInstance}).`
                : `Falha ao entregar mensagem na Evolution API (HTTP ${attempt.status}).`,
            details: attempt.responseText.slice(0, 400),
          },
        };
      }

      console.log('[WhatsApp Gateway][Mensagem Entregue]', {
        eventType,
        instance: activeInstance,
        to: targetNumber,
        httpStatus: attempt.status,
      });

      return {
        httpStatus: 200,
        payload: {
          success: true,
          delivered: true,
          mode: 'LIVE_EVOLUTION',
          provider: 'EVOLUTION',
          instanceName: activeInstance,
          endpoint: attempt.endpoint,
          to: targetNumber,
          eventType,
          timestamp,
        },
      };
    }

    // Demais provedores: META_CLOUD ou WEBHOOK genérico
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cfg.apiToken) {
      headers.Authorization = `Bearer ${cfg.apiToken}`;
      headers.apikey = cfg.apiToken;
    }

    const outboundPayload =
      cfg.provider === 'META_CLOUD'
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: sanitizedTo,
            type: 'text',
            text: {
              preview_url: false,
              body: message,
            },
          }
        : {
            to: sanitizedTo,
            message,
            eventType,
            source: 'TechReserve',
            timestamp,
            metadata: body.metadata || {},
          };

    console.log('[WhatsApp Gateway][Disparando Webhook/Cloud]', {
      provider: cfg.provider,
      endpoint: cfg.directSendUrl,
      to: sanitizedTo,
      eventType,
    });

    const upstreamResponse = await fetchWithTimeout(
      cfg.directSendUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(outboundPayload),
      },
      UPSTREAM_TIMEOUT_MS
    );

    const responseText = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      console.error('[WhatsApp Gateway][Erro Provedor]', {
        provider: cfg.provider,
        endpoint: cfg.directSendUrl,
        httpStatus: upstreamResponse.status,
        response: responseText.slice(0, 400),
      });
      return {
        httpStatus: 502,
        payload: {
          success: false,
          delivered: false,
          provider: cfg.provider,
          endpoint: cfg.directSendUrl,
          status: upstreamResponse.status,
          error: `Falha no provedor WhatsApp (HTTP ${upstreamResponse.status}).`,
          details: responseText.slice(0, 400),
        },
      };
    }

    console.log('[WhatsApp Gateway][Mensagem Entregue via Webhook/Cloud]', {
      provider: cfg.provider,
      to: sanitizedTo,
      eventType,
    });

    return {
      httpStatus: 200,
      payload: {
        success: true,
        delivered: true,
        mode: 'LIVE_WEBHOOK',
        provider: cfg.provider,
        endpoint: cfg.directSendUrl,
        to: sanitizedTo,
        eventType,
        timestamp,
      },
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    console.error('[WhatsApp Gateway][Exceção de Rede]', {
      eventType,
      to: sanitizedTo,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      httpStatus: 502,
      payload: {
        success: false,
        delivered: false,
        provider: cfg.provider,
        error: isAbort
          ? 'O servidor WhatsApp demorou para responder (iniciando instância). Tente novamente em alguns segundos.'
          : err instanceof Error
          ? err.message
          : 'Erro de comunicação com o provedor WhatsApp.',
      },
    };
  }
}

/**
 * Mantém a instância Evolution API acordada (evitando cold-start em hospedagens como Render).
 */
export async function pingEvolutionKeepAlive(): Promise<void> {
  const cfg = resolveWhatsAppConfig();
  if (!cfg.configured || cfg.provider !== 'EVOLUTION' || !cfg.baseUrl) return;
  try {
    await fetchWithTimeout(
      `${cfg.baseUrl}/`,
      { method: 'GET', headers: buildEvolutionHeaders(cfg.apiToken, false) },
      20000
    );
  } catch {
    // Silencioso em background
  }
}
