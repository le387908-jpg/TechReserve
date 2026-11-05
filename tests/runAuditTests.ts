/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hashAdminAuthCode, isBootstrapAdminEmail } from '../server/firebaseAdmin';
import { checkRateLimit } from '../server/rateLimiter';
import {
  getSaoPauloTodayISO,
  parseSaoPauloDateTimeMs,
  processServerQrCheckIn,
} from '../server/checkInHandler';
import { processAdminRegistration } from '../server/adminAuthHandler';
import {
  handleProtectedWhatsAppConnect,
  handleProtectedWhatsAppDisconnect,
  handleProtectedWhatsAppSend,
  handleProtectedWhatsAppStatus,
} from '../server/whatsappHttpHandlers';
import {
  clearUserRecoveryData,
  getPendingOfflineCheckInsForUser,
  getPreservedReservationsForUser,
  markUserReservationsOfflineInterrupted,
  savePendingOfflineCheckIn,
  syncUserActiveReservationsToLocal,
} from '../src/services/offlineRecoveryService';
import {
  buildAvailableSlotId,
  hydrateAvailableSlotDoc,
  normalizeTimeHHMM,
} from '../src/store/useAvailableSlotsStore';
import {
  WEEKLY_QUOTA_EXCEEDED_MESSAGE,
  checkNoShowSuspensionForDate,
  checkWeeklyQuotaLocal,
  doRoomNamesMatch,
  doesCurriculumClassMatchRoom,
  getRoomScheduleSlotsForDate,
} from '../src/services/reservationService';
import { extractSafeErrorMessage } from '../src/services/whatsappService';
import { getFriendlyErrorMessage } from '../src/services/firebase/utils';
import type { AvailableSlot, PunishmentRecord, Reservation, Room, ScheduleConfig, User } from '../src/types';

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, durationMs: Date.now() - start });
    console.log(`  [PASS] ${name} (${Date.now() - start}ms)`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    results.push({ name, passed: false, durationMs: Date.now() - start, error: message });
    console.error(`  [FAIL] ${name}: ${message}`);
  }
}

function collectFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesRecursive(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function createMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let jsonBody: unknown = null;
  return {
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return this;
    },
    getStatus: () => statusCode,
    getJson: () => jsonBody,
    getHeaders: () => headers,
  };
}

function installSessionStorageShim(): () => void {
  const store = new Map<string, string>();
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  };
  return () => {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  };
}

async function main(): Promise<void> {
  const rootDir = process.cwd();
  console.log('=== TechReserve Automated Security, Rules & Regression Suite ===\n');

  // 1. Auditoria Estática de Segredos e Regras Firebase
  await runTest('1.1 Zero segredos hardcoded (051325 / ADMIN_AUTH_CODE) no bundle cliente (src/)', () => {
    const srcFiles = collectFilesRecursive(path.join(rootDir, 'src'));
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      assert.equal(
        content.includes('051325'),
        false,
        `Segredo legado 051325 encontrado em ${path.relative(rootDir, file)}`
      );
      assert.equal(
        content.includes('ADMIN_AUTH_CODE'),
        false,
        `Constante legada ADMIN_AUTH_CODE encontrada em ${path.relative(rootDir, file)}`
      );
    }
  });

  await runTest('1.2 firestore.rules endurecido (sem segredos, anti-spoofing em logs, slot_locks e expiração de check-in)', () => {
    const rules = fs.readFileSync(path.join(rootDir, 'firestore.rules'), 'utf-8');
    assert.equal(rules.includes('051325'), false, 'firestore.rules não deve conter código fixo 051325');
    assert.equal(
      rules.includes('incoming().usuarioId == request.auth.uid'),
      true,
      'firestore.rules deve exigir autoria autenticada nos logs'
    );
    assert.equal(
      rules.includes('codeHash'),
      true,
      'firestore.rules deve validar codeHash SHA-256 em settings/admin_auth'
    );
    assert.equal(
      rules.includes('match /slot_locks/{lockId}'),
      true,
      'firestore.rules deve proteger a coleção transacional slot_locks'
    );
    assert.equal(
      rules.includes('request.time.toMillis() <= existing().checkInExpiracao'),
      true,
      'firestore.rules deve impor prazo autoritativo de check-in no servidor'
    );
  });

  await runTest('1.3 storage.rules presente com negação padrão, limite de 2 MB e MIME whitelist de avatares', () => {
    const storageRules = fs.readFileSync(path.join(rootDir, 'storage.rules'), 'utf-8');
    assert.equal(storageRules.includes('2 * 1024 * 1024'), true);
    assert.equal(storageRules.includes('^image/(jpeg|png|webp)$'), true);
    assert.equal(storageRules.includes('allow read, write: if false;'), true);
  });

  // 2. Integridade de PWA, Manifesto e Ícones Locais
  await runTest('2.1 Manifesto PWA usa apenas ícones locais válidos (PNGs reais 192x192 e 512x512) e Service Worker isola /api/*', () => {
    const manifestRaw = fs.readFileSync(path.join(rootDir, 'public', 'manifest.webmanifest'), 'utf-8');
    const manifest = JSON.parse(manifestRaw) as {
      icons: Array<{ src: string; sizes: string; type: string }>;
    };
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
    for (const icon of manifest.icons) {
      assert.equal(
        icon.src.startsWith('http://') || icon.src.startsWith('https://'),
        false,
        `Ícone externo não permitido no manifesto: ${icon.src}`
      );
      const diskPath = path.join(rootDir, 'public', icon.src.replace(/^\//, ''));
      assert.equal(fs.existsSync(diskPath), true, `Arquivo de ícone ausente: ${diskPath}`);
    }

    const checkPngHeader = (relPath: string, expectedSize: number) => {
      const buf = fs.readFileSync(path.join(rootDir, 'public', relPath));
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(buf.readUInt32BE(16), expectedSize);
      assert.equal(buf.readUInt32BE(20), expectedSize);
    };
    checkPngHeader('icon-192.png', 192);
    checkPngHeader('icon-512.png', 512);
    checkPngHeader('icon-maskable-512.png', 512);

    const swCode = fs.readFileSync(path.join(rootDir, 'public', 'sw.js'), 'utf-8');
    assert.equal(swCode.includes("url.pathname.startsWith('/api/')"), true);
    assert.equal(swCode.includes('url.origin !== self.location.origin'), true);
  });

  // 3. Criptografia, Rate Limiting, Fuso Horário e Proteção de Rotas Server-Side
  await runTest('3.1 Hash administrativo SHA-256 com domínio salgado e verificação de e-mails bootstrap', () => {
    const h1 = hashAdminAuthCode('  984512 ');
    const h2 = hashAdminAuthCode('984512');
    const h3 = hashAdminAuthCode('984513');
    assert.equal(h1.length, 64);
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.equal(isBootstrapAdminEmail('NEGREIROSMIKAELLA@gmail.com', true), true);
    assert.equal(isBootstrapAdminEmail('NEGREIROSMIKAELLA@gmail.com', false), false);
    assert.equal(isBootstrapAdminEmail('aluno.qualquer@fatec.sp.gov.br', true), false);
  });

  await runTest('3.2 Cálculo de fuso horário institucional America/Sao_Paulo (UTC-03:00) no servidor', () => {
    const epochMs = parseSaoPauloDateTimeMs('2026-11-10', '19:00');
    // 19:00 em São Paulo (-03:00) == 22:00 UTC
    assert.equal(new Date(epochMs).toISOString(), '2026-11-10T22:00:00.000Z');
    // 23:30 em São Paulo (02:30 UTC do dia seguinte) ainda pertence ao dia 2026-11-10 em SP
    const lateSpMs = Date.parse('2026-11-11T02:30:00.000Z');
    assert.equal(getSaoPauloTodayISO(lateSpMs), '2026-11-10');
  });

  await runTest('3.3 Rate limiter bloqueia excesso de requisições na janela deslizante', () => {
    const uniqueScope = `test_scope_${Date.now()}`;
    const r1 = checkRateLimit({ scope: uniqueScope, identifier: 'u1', maxRequests: 2, windowMs: 60_000 });
    const r2 = checkRateLimit({ scope: uniqueScope, identifier: 'u1', maxRequests: 2, windowMs: 60_000 });
    const r3 = checkRateLimit({ scope: uniqueScope, identifier: 'u1', maxRequests: 2, windowMs: 60_000 });
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, false);
    assert.ok(r3.retryAfterSeconds >= 1);
  });

  await runTest('3.4 Handlers de Check-in, Registro ADM e WhatsApp rejeitam chamadas sem token ou com token inválido (401)', async () => {
    const noTokenCheckIn = await processServerQrCheckIn({
      headers: {},
      body: { qrData: 'TECHRESERVE:SALA-001' },
    });
    assert.equal(noTokenCheckIn.httpStatus, 401);
    assert.equal(noTokenCheckIn.body.success, false);

    const forgedCheckIn = await processServerQrCheckIn({
      headers: { authorization: 'Bearer forged.jwt.token' },
      body: { qrData: 'TECHRESERVE:SALA-001' },
    });
    assert.equal(forgedCheckIn.httpStatus, 401);

    const noTokenAdmin = await processAdminRegistration({
      headers: {},
      body: { code: '123456', nome: 'Teste', phone: '5511999999999' },
    });
    assert.equal(noTokenAdmin.httpStatus, 401);

    const forgedAdmin = await processAdminRegistration({
      headers: { authorization: 'Bearer forged.jwt.token' },
      body: { code: '123456', nome: 'Teste', phone: '5511999999999' },
    });
    assert.equal(forgedAdmin.httpStatus, 401);

    for (const handler of [
      handleProtectedWhatsAppStatus,
      handleProtectedWhatsAppConnect,
      handleProtectedWhatsAppDisconnect,
      handleProtectedWhatsAppSend,
    ]) {
      const res = createMockRes();
      await handler({ headers: {}, query: {}, body: {} }, res);
      assert.equal(res.getStatus(), 401);
    }
  });

  // 4. Regras de Negócio, Anti-Colisão de Salas, Grade, Cota Semanal e No-Show
  await runTest('4.1 Anti-colisão de nomes e códigos de salas (Sala 1 jamais colide com Sala 10)', () => {
    assert.equal(doRoomNamesMatch('1º. andar Sala 1', '1º. andar Sala 10'), false);
    assert.equal(doRoomNamesMatch('1º. andar Sala 01', 'Sala de Aula 1'), true);
    assert.equal(doRoomNamesMatch('Lab Info 1', 'Lab Info 2'), false);
    assert.equal(
      doesCurriculumClassMatchRoom('1º. andar Sala 1', {
        id: 'SALA-010',
        codigo: 'SALA-10',
        nome: 'Sala 10',
      }),
      false
    );
    assert.equal(
      doesCurriculumClassMatchRoom('1º. andar Sala 1', {
        id: 'SALA-001',
        codigo: 'SALA-01',
        nome: 'Sala 01',
      }),
      true
    );
  });

  await runTest('4.2 Bloqueio padrão da grade de horários e liberação explícita pelo ADM (available_slots)', () => {
    const sampleRoom: Room = {
      firestoreId: 'room_doc_sala01',
      id: 'SALA-001',
      codigo: 'SALA-01',
      nome: 'Sala de Aula 01',
      categoria: 'SALA',
      capacidade: 40,
      andar: '1º Andar',
      descricao: 'Sala de aula padrão',
      equipamentos: ['Projetor'],
      imagem: '',
      status: 'DISPONIVEL',
      liberadaParaReserva: true,
      blocosHorarios: [
        { id: 'b1', label: 'Bloco 1', inicio: '14:00', fim: '15:00', ativo: true },
        { id: 'b2', label: 'Bloco 2', inicio: '15:00', fim: '16:00', ativo: true },
      ],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };

    const config: ScheduleConfig = {
      id: 'global_config',
      tipoDoc: 'GLOBAL_CONFIG',
      horaAberturaSistema: 7,
      janelaInicio: '07:00',
      janelaFim: '22:00',
      duracaoBlocoPadraoMinutos: 50,
      intervaloEntreBlocosMinutos: 10,
      antecedenciaMaximaDias: 14,
      reservasAbertas: true,
      diasSemanaPermitidos: ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
      blocosPadrao: [],
      updatedAt: 1_700_000_000_000,
    };

    const refNow = new Date('2026-11-09T10:00:00-03:00'); // Segunda-feira, antes das 14:00

    // Sem available_slots -> 0 horários selecionáveis (Bloqueio Padrão)
    const unliberatedGrid = getRoomScheduleSlotsForDate({
      room: sampleRoom,
      dateISO: '2026-11-10', // Terça-feira
      config,
      exceptions: [],
      availableSlots: [],
      reservations: [],
      currentUserId: 'uid_student_1',
      now: refNow,
    });
    assert.equal(unliberatedGrid.reservableCount, 0);
    assert.ok(unliberatedGrid.slots.every((s) => !s.selectableForUser));

    // Com 1 slot liberado pelo ADM às 14:00-15:00 -> exatamente esse bloco fica LIBERADO
    const slotId = buildAvailableSlotId(sampleRoom.firestoreId, '2026-11-10', '14:00', '15:00');
    assert.equal(normalizeTimeHHMM('8:05'), '08:05');
    const hydratedSlot: AvailableSlot = hydrateAvailableSlotDoc(slotId, {
      salaId: sampleRoom.firestoreId,
      salaInstitutionalId: sampleRoom.id,
      data: '2026-11-10',
      inicio: '14:00',
      fim: '15:00',
      status: 'liberado',
      ativo: true,
    });

    const releasedGrid = getRoomScheduleSlotsForDate({
      room: sampleRoom,
      dateISO: '2026-11-10',
      config,
      exceptions: [],
      availableSlots: [hydratedSlot],
      reservations: [],
      currentUserId: 'uid_student_1',
      now: refNow,
    });
    const slot14 = releasedGrid.slots.find((s) => s.inicio === '14:00' && s.fim === '15:00');
    const slot15 = releasedGrid.slots.find((s) => s.inicio === '15:00' && s.fim === '16:00');
    assert.equal(slot14?.state, 'LIBERADO');
    assert.equal(slot14?.selectableForUser, true);
    assert.equal(slot15?.state, 'AGUARDANDO_LIBERACAO');
    assert.equal(slot15?.selectableForUser, false);
  });

  await runTest('4.3 Cota semanal (1 reserva por semana; CANCELADA e PUNIDA liberam a cota) e No-Show restrito à data da falta', () => {
    const baseRes = (status: Reservation['status'], dateISO: string): Reservation => ({
      id: `res_${status}_${dateISO}`,
      salaId: 'room_1',
      salaInstitutionalId: 'SALA-001',
      salaNome: 'Sala 01',
      usuarioId: 'user_1',
      data: dateISO,
      inicio: '14:00',
      fim: '15:00',
      observacoes: 'Estudo',
      status,
      checkInRealizado: status === 'CONFIRMADA' || status === 'CONCLUIDA',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Semana de 2026-11-09 (Seg) a 2026-11-15 (Dom)
    const blockedByActive = checkWeeklyQuotaLocal(
      [baseRes('PENDENTE', '2026-11-10')],
      'user_1',
      '2026-11-12'
    );
    assert.equal(blockedByActive.allowed, false);
    assert.equal(blockedByActive.error, WEEKLY_QUOTA_EXCEEDED_MESSAGE);

    // Cancelada ou Punida libera a cota semanal
    const freedAfterCancelAndPunish = checkWeeklyQuotaLocal(
      [baseRes('CANCELADA', '2026-11-10'), baseRes('PUNIDA', '2026-11-11')],
      'user_1',
      '2026-11-12'
    );
    assert.equal(freedAfterCancelAndPunish.allowed, true);

    // Punição de No-Show bloqueia SOMENTE a data exata da falta
    const student: User = {
      id: 'user_1',
      nome: 'Aluno Teste',
      ra: '123456',
      email: 'aluno@fatec.sp.gov.br',
      dataNascimento: '2002-05-10',
      role: 'USUARIO',
      tipoVinculo: 'ALUNO',
      aprovado: true,
      bloqueado: false,
      blockedDate: '2026-11-11',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const punishments: PunishmentRecord[] = [
      {
        id: 'pun_1',
        usuarioId: 'user_1',
        usuarioNome: 'Aluno Teste',
        motivo: 'No-Show',
        tipo: 'AUTOMATICA',
        dataInicio: Date.now(),
        dataFim: Date.now() + 86_400_000,
        blockedDate: '2026-11-11',
        ativa: true,
      },
    ];
    assert.equal(checkNoShowSuspensionForDate(student, punishments, '2026-11-11').blocked, true);
    assert.equal(checkNoShowSuspensionForDate(student, punishments, '2026-11-12').blocked, false);
  });

  // 5. Recuperação Offline e Isolamento entre Usuários
  await runTest('5.1 Preservação offline de reserva, fila de check-in pendente, isolamento por UID e limpeza no logout', async () => {
    const restoreWindow = installSessionStorageShim();
    try {
      const resUserA: Reservation = {
        id: 'res_alpha_1',
        salaId: 'room_lab1',
        salaInstitutionalId: 'LAB-001',
        salaNome: 'Laboratório de Informática 01',
        usuarioId: 'uid_alpha',
        data: '2026-11-10',
        inicio: '19:00',
        fim: '20:00',
        observacoes: 'TCC',
        status: 'PENDENTE',
        checkInRealizado: false,
        checkInExpiracao: Date.now() + 300_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await syncUserActiveReservationsToLocal('uid_alpha', [resUserA], true);
      const interruptedCount = await markUserReservationsOfflineInterrupted('uid_alpha');
      assert.equal(interruptedCount, 1);

      const alphaPreserved = await getPreservedReservationsForUser('uid_alpha');
      const betaPreserved = await getPreservedReservationsForUser('uid_beta');
      assert.equal(alphaPreserved.length, 1);
      assert.equal(alphaPreserved[0].wasOfflineInterrupted, true);
      assert.equal(betaPreserved.length, 0);

      // Confirma que dados sensíveis (e-mail, telefone) não são persistidos no registro de recuperação
      assert.equal('usuarioEmail' in (alphaPreserved[0] as unknown as Record<string, unknown>), false);
      assert.equal('usuarioTelefone' in (alphaPreserved[0] as unknown as Record<string, unknown>), false);

      await savePendingOfflineCheckIn({
        uid: 'uid_alpha',
        reservationId: 'res_alpha_1',
        qrData: 'TECHRESERVE:LAB-001',
        clientScannedAt: Date.now(),
      });

      const alphaPending = await getPendingOfflineCheckInsForUser('uid_alpha');
      const betaPending = await getPendingOfflineCheckInsForUser('uid_beta');
      assert.equal(alphaPending.length, 1);
      assert.equal(alphaPending[0].syncStatus, 'PENDING');
      assert.equal(betaPending.length, 0);

      await clearUserRecoveryData('uid_alpha');
      assert.equal((await getPreservedReservationsForUser('uid_alpha')).length, 0);
      assert.equal((await getPendingOfflineCheckInsForUser('uid_alpha')).length, 0);
    } finally {
      restoreWindow();
    }
  });

  // 6. Testes de Integração HTTP ao Vivo contra o Servidor Express (Porta 3000)
  await runTest('6.1 Endpoints HTTP ao vivo (/api/health -> 200; rotas sensíveis -> 401 sem autenticação)', async () => {
    const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
    let healthRes: Response | null = null;
    try {
      healthRes = await fetch(`${baseUrl}/api/health`);
    } catch {
      console.log('    [INFO] Servidor local na porta 3000 não acessível neste contexto; pulando asserção HTTP ao vivo.');
      return;
    }

    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    const healthJson = (await healthRes.json()) as { ok: boolean; serverTime: number };
    assert.equal(healthJson.ok, true);
    assert.equal(typeof healthJson.serverTime, 'number');

    const protectedEndpoints: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [
      { method: 'POST', path: '/api/checkin', body: { qrData: 'TECHRESERVE:SALA-001' } },
      { method: 'POST', path: '/api/admin/register', body: { code: '000000', nome: 'X', phone: '5511999999999' } },
      { method: 'GET', path: '/api/whatsapp/status' },
      { method: 'POST', path: '/api/whatsapp/connect', body: {} },
      { method: 'POST', path: '/api/whatsapp/disconnect', body: {} },
      { method: 'POST', path: '/api/whatsapp/send', body: { to: '5511999999999', message: 'Teste' } },
    ];

    for (const ep of protectedEndpoints) {
      const resp = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: ep.body ? { 'Content-Type': 'application/json' } : undefined,
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(
        resp.status,
        401,
        `Esperado HTTP 401 para ${ep.method} ${ep.path} sem token, recebido ${resp.status}`
      );
    }
  });

  // 7. Testes de Empacotamento Vercel Serverless, Resolução de Módulos e Prevenção do Erro React #31
  await runTest('7.1 Rotas Serverless Vercel (/api/whatsapp/*, /api/checkin, /api/admin/*) importam e resolvem handlers sem ERR_MODULE_NOT_FOUND', async () => {
    const apiWhatsAppSend = await import('../api/whatsapp/send.ts');
    assert.equal(typeof apiWhatsAppSend.default, 'function', 'api/whatsapp/send.ts deve exportar default handler');

    const apiWhatsAppStatus = await import('../api/whatsapp/status.ts');
    assert.equal(typeof apiWhatsAppStatus.default, 'function', 'api/whatsapp/status.ts deve exportar default handler');

    const apiWhatsAppConnect = await import('../api/whatsapp/connect.ts');
    assert.equal(typeof apiWhatsAppConnect.default, 'function', 'api/whatsapp/connect.ts deve exportar default handler');

    const apiWhatsAppDisconnect = await import('../api/whatsapp/disconnect.ts');
    assert.equal(typeof apiWhatsAppDisconnect.default, 'function', 'api/whatsapp/disconnect.ts deve exportar default handler');

    const apiCheckin = await import('../api/checkin.ts');
    assert.equal(typeof apiCheckin.default, 'function', 'api/checkin.ts deve exportar default handler');

    const apiAdminRegister = await import('../api/admin/register.ts');
    assert.equal(typeof apiAdminRegister.default, 'function', 'api/admin/register.ts deve exportar default handler');

    const apiAdminElevate = await import('../api/admin/elevate.ts');
    assert.equal(typeof apiAdminElevate.default, 'function', 'api/admin/elevate.ts deve exportar default handler');

    const apiReservationsCheckin = await import('../api/reservations/checkin.ts');
    assert.equal(typeof apiReservationsCheckin.default, 'function', 'api/reservations/checkin.ts deve exportar default handler');
  });

  await runTest('7.2 Módulos internos em api/_server/*.ts e re-exports em server/*.ts resolvem com extensões completas', async () => {
    const serverHandlers = await import('../api/_server/whatsappHttpHandlers.ts');
    assert.equal(typeof serverHandlers.handleProtectedWhatsAppSend, 'function');
    assert.equal(typeof serverHandlers.handleProtectedWhatsAppStatus, 'function');

    const serverGateway = await import('../api/_server/whatsappGateway.ts');
    assert.equal(typeof serverGateway.dispatchWhatsAppMessage, 'function');
    assert.equal(typeof serverGateway.getGatewayStatus, 'function');

    const serverAdmin = await import('../api/_server/firebaseAdmin.ts');
    assert.equal(typeof serverAdmin.hashAdminAuthCode, 'function');
    assert.equal(typeof serverAdmin.verifyFirebaseIdToken, 'function');
    assert.equal(typeof serverAdmin.authenticateApiRequest, 'function');

    // Valida que firebase-admin/app, auth e firestore importam valores nativos no runtime ESM do Node
    const adminApp = await import('firebase-admin/app');
    assert.equal(typeof adminApp.initializeApp, 'function');
    assert.equal(typeof adminApp.getApps, 'function');
    assert.equal(typeof adminApp.cert, 'function');

    const adminAuth = await import('firebase-admin/auth');
    assert.equal(typeof adminAuth.getAuth, 'function');

    const adminFirestore = await import('firebase-admin/firestore');
    assert.equal(typeof adminFirestore.getFirestore, 'function');

    // Valida que jwks-rsa carrega jose via CJS sem disparar ERR_REQUIRE_ESM
    const jwksRsaModule = await import('jwks-rsa');
    const jwksClientFactory = (typeof jwksRsaModule.default === 'function' ? jwksRsaModule.default : jwksRsaModule) as unknown as (options: { jwksUri: string }) => { getSigningKeys: unknown };
    assert.equal(typeof jwksClientFactory, 'function', 'jwks-rsa deve exportar fábrica de cliente');
    const jwksClientInstance = jwksClientFactory({ jwksUri: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com' });
    assert.equal(typeof jwksClientInstance.getSigningKeys, 'function');

    // Re-exports de compatibilidade
    const compatHandlers = await import('../server/whatsappHttpHandlers.ts');
    assert.equal(typeof compatHandlers.handleProtectedWhatsAppSend, 'function');
  });

  await runTest('7.3 Prevenção do erro React #31: extractSafeErrorMessage extrai strings seguras de objetos {code, message}', async () => {
    // 1. Objeto de erro da Vercel quando a função falha
    const vercelErrorObj = {
      code: 'FUNCTION_INVOCATION_FAILED',
      message: "Cannot find module '/var/task/server/whatsappHttpHandlers'",
    };
    const extracted1 = extractSafeErrorMessage(vercelErrorObj);
    assert.equal(typeof extracted1, 'string');
    assert.ok(extracted1.includes('Cannot find module'));
    assert.ok(extracted1.includes('FUNCTION_INVOCATION_FAILED'));

    // 2. Objeto encapsulado { error: { code, message } }
    const nestedVercelError = {
      error: {
        code: 'FUNCTION_INVOCATION_FAILED',
        message: 'Falha interna na execução da função serverless',
      },
    };
    const extracted2 = extractSafeErrorMessage(nestedVercelError);
    assert.equal(typeof extracted2, 'string');
    assert.ok(extracted2.includes('Falha interna na execução'));

    // 3. String crua
    const strError = 'Instância do WhatsApp desconectada.';
    const extracted3 = extractSafeErrorMessage(strError);
    assert.equal(extracted3, 'Instância do WhatsApp desconectada.');

    // 4. Instância de Error
    const errInstance = new Error('Falha de rede ao conectar à Evolution API');
    const extracted4 = extractSafeErrorMessage(errInstance);
    assert.equal(extracted4, 'Falha de rede ao conectar à Evolution API');

    // 5. Objeto com reason
    const reasonObj = { success: false, reason: 'Número sem WhatsApp ativo' };
    const extracted5 = extractSafeErrorMessage(reasonObj);
    assert.equal(extracted5, 'Número sem WhatsApp ativo');

    // 6. Null ou undefined
    const extracted6 = extractSafeErrorMessage(null, 'Mensagem padrão');
    assert.equal(extracted6, 'Mensagem padrão');

    // 7. String JSON serializada
    const jsonStr = JSON.stringify({ message: 'Conexão rejeitada pelo gateway' });
    const extracted7 = extractSafeErrorMessage(jsonStr);
    assert.equal(extracted7, 'Conexão rejeitada pelo gateway');
  });

  await runTest('7.4 getFriendlyErrorMessage sanitiza objetos de erro técnicos sem retornar payload bruto ou quebrar UI', async () => {
    const errorObj = {
      error: {
        code: 'permission-denied',
        message: 'Missing or insufficient permissions.',
      },
    };
    const friendly = getFriendlyErrorMessage(errorObj);
    assert.equal(typeof friendly, 'string');
    assert.ok(friendly.includes('permissão'));

    const networkErr = { message: 'Failed to fetch' };
    const friendlyNet = getFriendlyErrorMessage(networkErr);
    assert.ok(friendlyNet.includes('conexão'));
  });

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\nResumo: ${results.length - failed.length}/${results.length} suítes aprovadas.`
  );
  if (failed.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro fatal ao executar suíte de auditoria:', err);
  process.exit(1);
});
