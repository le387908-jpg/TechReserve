/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  deleteUser,
} from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { auth, db, ensureTabIsolationReady } from './firebase/config';
import { User, UserRole, UserVinculo, CalendarCourse } from '../types';
import {
  OperationType,
  handleFirestoreError,
  stripUndefinedFields,
  withRetry,
} from './firebase/utils';
import { normalizeDateToISO } from '../utils/dateUtils';
import {
  formatPhone,
  getPhoneValidationMessage,
  sanitizePhone,
  validatePhone,
} from '../utils/formatters';
import { useLogStore } from '../store/useLogStore';

export interface SignUpPayload {
  email: string;
  pass: string;
  nome: string;
  phone: string;
  whatsappNotificationsEnabled?: boolean;
  ra?: string;
  tipoVinculo?: UserVinculo;
  dataNascimento: string;
  role: UserRole;
  code?: string;
  curso?: CalendarCourse;
  semestre?: number;
}

const TAB_SESSION_STORAGE_KEY = 'techreserve_tab_auth_user_v1';

// Estado em memória estritamente isolado na instância JS da aba atual
let inMemoryTabUserSnapshot: User | null = null;
let isRegisteringInTab = false;
let registeringUidInTab: string | null = null;

/**
 * Armazena o snapshot do usuário autenticado EXCLUSIVAMENTE no `sessionStorage` (e memória) da aba atual.
 * Jamais utiliza `localStorage` nem eventos `storage`, impedindo qualquer sincronização entre abas.
 */
export function saveTabUserSession(user: User | null): void {
  inMemoryTabUserSnapshot = user;
  if (typeof window === 'undefined') return;
  try {
    if (user) {
      window.sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, JSON.stringify(user));
    } else {
      window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
    }
  } catch {
    // Caso sessionStorage esteja indisponível, mantém apenas em memória da aba
  }
}

/**
 * Recupera o snapshot de usuário isolado da aba atual (`sessionStorage` / memória).
 */
export function loadTabUserSession(): User | null {
  if (typeof window === 'undefined') return inMemoryTabUserSnapshot;
  try {
    const raw = window.sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    if (!raw) return inMemoryTabUserSnapshot;
    const parsed = JSON.parse(raw) as User;
    if (parsed && typeof parsed.id === 'string') {
      const normalizedRole: UserRole = parsed.role === 'ADMIN' ? 'ADMIN' : 'USUARIO';
      const normalizedUser: User = {
        ...parsed,
        role: normalizedRole,
        tipoVinculo:
          normalizedRole === 'ADMIN'
            ? 'COORDENACAO'
            : parsed.tipoVinculo === 'SERVIDOR'
            ? 'SERVIDOR'
            : 'ALUNO',
      };
      inMemoryTabUserSnapshot = normalizedUser;
      return normalizedUser;
    }
    return null;
  } catch {
    return inMemoryTabUserSnapshot;
  }
}

export function clearTabUserSession(): void {
  saveTabUserSession(null);
}

export function translateAuthError(code?: string, fallback?: string): string {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
      return 'E-mail ou senha incorretos. Verifique suas credenciais e tente novamente.';
    case 'auth/user-not-found':
      return 'Este e-mail não está cadastrado no sistema.';
    case 'auth/invalid-email':
      return 'O formato do e-mail informado é inválido.';
    case 'auth/email-already-in-use':
      return 'Este e-mail já está em uso por outro cadastro.';
    case 'auth/weak-password':
      return 'A senha é muito fraca. Deve ter pelo menos 6 caracteres.';
    case 'auth/user-disabled':
      return 'Sua conta foi desativada pelo administrador.';
    case 'auth/too-many-requests':
      return 'Acesso bloqueado temporariamente por excesso de tentativas incorretas. Tente novamente mais tarde.';
    case 'auth/operation-not-allowed':
      return 'Operação de autenticação não permitida.';
    case 'auth/network-request-failed':
      return 'Falha na conexão com o servidor. Verifique sua internet.';
    case 'auth/missing-password':
      return 'Por favor, digite sua senha.';
    case 'auth/missing-email':
      return 'Por favor, insira o seu e-mail.';
    case 'auth/popup-closed-by-user':
      return 'A janela de login foi fechada antes de concluir o processo.';
    default:
      return fallback || 'Não foi possível concluir a autenticação.';
  }
}

/**
 * Normaliza campos do documento `users/{uid}` do Firestore garantindo consistência estrita de papel (`role`):
 * - Apenas documentos explicitamente gravados com `role === 'ADMIN'` recebem perfil ADM.
 * - Qualquer outro documento permanece estritamente como `USUARIO` (`ALUNO` ou `SERVIDOR`).
 */
export function hydrateUserDocument(
  raw: Record<string, any> | undefined | null,
  fallbackUid: string
): User {
  const safeRaw = raw || {};
  const nome = String(safeRaw.nome || safeRaw.name || 'Usuário');
  const resolvedRole: UserRole = safeRaw.role === 'ADMIN' ? 'ADMIN' : 'USUARIO';
  const resolvedVinculo: UserVinculo =
    resolvedRole === 'ADMIN'
      ? 'COORDENACAO'
      : safeRaw.tipoVinculo === 'SERVIDOR'
      ? 'SERVIDOR'
      : 'ALUNO';
  const curso = safeRaw.curso || safeRaw.course;
  const semestre = safeRaw.semestre ?? safeRaw.semester;
  const sanitizedPhone = sanitizePhone(
    safeRaw.phone || safeRaw.phoneFormatted || safeRaw.telefone || ''
  );
  const formattedPhone = sanitizedPhone ? formatPhone(sanitizedPhone) : '';

  return {
    ...(safeRaw as User),
    id: String(safeRaw.id || fallbackUid || ''),
    nome,
    name: nome,
    email: String(safeRaw.email || ''),
    role: resolvedRole,
    tipoVinculo: resolvedVinculo,
    phone: sanitizedPhone,
    phoneFormatted: formattedPhone,
    whatsappNotificationsEnabled: safeRaw.whatsappNotificationsEnabled !== false,
    blockedDate: safeRaw.blockedDate ? normalizeDateToISO(safeRaw.blockedDate) : '',
    ...(curso ? { curso, course: curso } : {}),
    ...(semestre !== undefined && semestre !== null ? { semestre, semester: semestre } : {}),
    dataNascimento: safeRaw.dataNascimento
      ? normalizeDateToISO(safeRaw.dataNascimento)
      : safeRaw.dataNascimento || '2000-01-01',
  };
}

/**
 * Perfis padrão criados como fallback de recuperação SEMPRE nascem estritamente como `USUARIO` (`ALUNO`).
 * Jamais há promoção automática para `ADMIN` com base em endereço de e-mail.
 */
function buildDefaultUserDocument(uid: string, email: string, displayName?: string | null): User {
  const resolvedName = displayName || email.split('@')[0] || 'Usuário';
  const now = Date.now();

  return {
    id: uid,
    nome: resolvedName,
    name: resolvedName,
    email: email.trim().toLowerCase(),
    phone: '',
    phoneFormatted: '',
    whatsappNotificationsEnabled: true,
    ra: '',
    tipoVinculo: 'ALUNO',
    dataNascimento: '2000-01-01',
    role: 'USUARIO',
    aprovado: true,
    bloqueado: false,
    blockedDate: '',
    motivoPunicao: '',
    curso: 'GTI',
    course: 'GTI',
    semestre: 1,
    semester: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Realiza login por e-mail e senha mantendo a sessão estritamente isolada na aba atual (`browserSessionPersistence`).
 */
export async function loginWithEmail(email: string, pass: string): Promise<User> {
  const cleanEmail = String(email || '').trim().toLowerCase();

  try {
    await ensureTabIsolationReady();

    const userCredential = await withRetry(() =>
      signInWithEmailAndPassword(auth, cleanEmail, pass)
    );

    const userRef = doc(db, 'users', userCredential.user.uid);
    const docSnap = await getDoc(userRef);

    let userData: User;
    if (docSnap.exists()) {
      userData = hydrateUserDocument(docSnap.data(), userCredential.user.uid);
    } else {
      const userEmail = userCredential.user.email || cleanEmail;
      userData = buildDefaultUserDocument(
        userCredential.user.uid,
        userEmail,
        userCredential.user.displayName
      );
      await setDoc(userRef, stripUndefinedFields(userData));
    }

    if (userData.bloqueado || userData.inativo) {
      clearTabUserSession();
      await firebaseSignOut(auth).catch(() => {});
      throw new Error('Sua conta está bloqueada ou suspensa pela administração.');
    }

    saveTabUserSession(userData);
    return userData;
  } catch (err: any) {
    const message = translateAuthError(err?.code, err?.message);
    throw new Error(message);
  }
}

/**
 * Cadastra um novo usuário:
 * - Perfil comum (`role === 'USUARIO'`) permanece estritamente como `USUARIO` (`ALUNO` ou `SERVIDOR`).
 * - Perfil administrativo (`role === 'ADMIN'`) exige obrigatoriamente o `code-auth` válido.
 */
export async function registerWithEmail(payload: SignUpPayload): Promise<User> {
  const {
    email,
    pass,
    nome,
    phone,
    whatsappNotificationsEnabled = true,
    ra,
    tipoVinculo,
    dataNascimento,
    role,
    code,
    curso,
    semestre,
  } = payload;

  isRegisteringInTab = true;
  const cleanEmail = String(email || '').trim().toLowerCase();
  const isAdminTarget = role === 'ADMIN';
  const submittedCode = isAdminTarget ? String(code || '').trim() : '';

  if (!validatePhone(phone)) {
    isRegisteringInTab = false;
    throw new Error(
      getPhoneValidationMessage(phone) ||
        'O número de telefone deve possuir 11 dígitos no formato (00) 00000-0000.'
    );
  }

  const sanitizedPhone = sanitizePhone(phone);
  const formattedPhone = formatPhone(sanitizedPhone);

  if (isAdminTarget && !submittedCode) {
    isRegisteringInTab = false;
    throw new Error('Informe o código de autorização administrativa (code-auth).');
  }

  let createdFirebaseUser: any = null;

  try {
    await ensureTabIsolationReady();

    const credential = await withRetry(() =>
      createUserWithEmailAndPassword(auth, cleanEmail, pass)
    );
    createdFirebaseUser = credential.user;
    registeringUidInTab = createdFirebaseUser.uid;

    const resolvedRole: UserRole = isAdminTarget ? 'ADMIN' : 'USUARIO';
    const resolvedVinculo: UserVinculo = isAdminTarget
      ? 'COORDENACAO'
      : tipoVinculo === 'SERVIDOR'
      ? 'SERVIDOR'
      : 'ALUNO';
    const cleanName = String(nome || '').trim().slice(0, 120) || 'Usuário';
    const resolvedCourse: CalendarCourse = curso || 'GTI';
    const resolvedSemester = semestre || 1;
    const now = Date.now();

    const userData: User = {
      id: createdFirebaseUser.uid,
      nome: cleanName,
      name: cleanName,
      email: cleanEmail,
      phone: sanitizedPhone,
      phoneFormatted: formattedPhone,
      whatsappNotificationsEnabled: Boolean(whatsappNotificationsEnabled),
      ra: (ra || '').trim().slice(0, 32),
      tipoVinculo: resolvedVinculo,
      dataNascimento: normalizeDateToISO(dataNascimento) || '2000-01-01',
      role: resolvedRole,
      aprovado: true,
      bloqueado: false,
      blockedDate: '',
      motivoPunicao: '',
      ...(isAdminTarget
        ? { authCodeSubmitted: submittedCode }
        : resolvedVinculo === 'SERVIDOR'
        ? { curso: resolvedCourse, course: resolvedCourse }
        : {
            curso: resolvedCourse,
            course: resolvedCourse,
            semestre: resolvedSemester,
            semester: resolvedSemester,
          }),
      createdAt: now,
      updatedAt: now,
    };

    await setDoc(doc(db, 'users', createdFirebaseUser.uid), stripUndefinedFields(userData));

    // Salva imediatamente na sessão exclusiva desta aba antes de encerrar a flag de registro
    saveTabUserSession(userData);

    await useLogStore
      .getState()
      .addLog({
        acao: isAdminTarget ? 'CADASTRO_NOVO_ADMIN' : 'CADASTRO_NOVO_USUARIO',
        usuarioId: createdFirebaseUser.uid,
        usuarioNome: userData.nome,
        entidade: 'USERS',
        detalhes: `Novo perfil ${
          isAdminTarget ? 'ADMINISTRATIVO' : resolvedVinculo
        } cadastrado (${cleanEmail} · WhatsApp: ${formattedPhone}).`,
      })
      .catch(() => {});

    return userData;
  } catch (err: any) {
    if (
      createdFirebaseUser &&
      isAdminTarget &&
      (err?.code === 'permission-denied' ||
        String(err?.message || '').toLowerCase().includes('permission') ||
        String(err?.message || '').toLowerCase().includes('insufficient'))
    ) {
      clearTabUserSession();
      try {
        await deleteUser(createdFirebaseUser);
      } catch {
        await firebaseSignOut(auth).catch(() => {});
      }
      throw new Error(
        'Código de autorização administrativa (code-auth) inválido ou cadastro de novos administradores desativado.'
      );
    }

    clearTabUserSession();
    throw new Error(translateAuthError(err?.code, err?.message));
  } finally {
    isRegisteringInTab = false;
    registeringUidInTab = null;
  }
}

/**
 * Encerra exclusivamente a sessão da aba atual sem impactar outros perfis logados em outras abas.
 */
export async function logoutTabSession(): Promise<void> {
  clearTabUserSession();
  await firebaseSignOut(auth).catch(() => {});
}

/**
 * Envia e-mail de redefinição de senha via Firebase Auth.
 */
export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, String(email || '').trim());
}

/**
 * Atualiza os dados do perfil no Firestore e sincroniza o snapshot `sessionStorage` da aba atual.
 * Impede qualquer escalonamento de privilégio (`role` ou `tipoVinculo: 'COORDENACAO'`) por usuários comuns.
 */
export async function updateUserProfileInFirestore(
  currentUser: User,
  data: Partial<User>
): Promise<User> {
  const sanitizedData: Record<string, any> = { ...data };
  if (currentUser.role !== 'ADMIN') {
    delete sanitizedData.curso;
    delete sanitizedData.course;
    delete sanitizedData.role;
    delete sanitizedData.bloqueado;
    delete sanitizedData.inativo;
    delete sanitizedData.aprovado;
    delete sanitizedData.authCodeSubmitted;
    if (sanitizedData.tipoVinculo !== undefined) {
      sanitizedData.tipoVinculo =
        sanitizedData.tipoVinculo === 'SERVIDOR' ? 'SERVIDOR' : 'ALUNO';
    }
  }

  if (sanitizedData.nome !== undefined) {
    const cleanName = String(sanitizedData.nome).trim().slice(0, 120);
    sanitizedData.nome = cleanName;
    sanitizedData.name = cleanName;
  }

  if (sanitizedData.phone !== undefined) {
    const rawPhone = String(sanitizedData.phone).trim();
    if (rawPhone) {
      if (!validatePhone(rawPhone)) {
        throw new Error(
          getPhoneValidationMessage(rawPhone) ||
            'O número de telefone deve possuir 11 dígitos no formato (00) 00000-0000.'
        );
      }
      const cleanDigits = sanitizePhone(rawPhone);
      sanitizedData.phone = cleanDigits;
      sanitizedData.phoneFormatted = formatPhone(cleanDigits);
    } else {
      sanitizedData.phone = '';
      sanitizedData.phoneFormatted = '';
    }
  }

  if (sanitizedData.semestre !== undefined) {
    sanitizedData.semester = sanitizedData.semestre;
  }

  if (sanitizedData.ra !== undefined) {
    sanitizedData.ra = String(sanitizedData.ra).trim().slice(0, 32);
  }

  if (sanitizedData.dataNascimento) {
    sanitizedData.dataNascimento = normalizeDateToISO(sanitizedData.dataNascimento);
  }

  const now = Date.now();
  const preservedRole: UserRole = currentUser.role === 'ADMIN' ? 'ADMIN' : 'USUARIO';
  const cleanUpdatePayload = stripUndefinedFields({
    ...sanitizedData,
    updatedAt: now,
  });
  const updatedUser: User = {
    ...currentUser,
    ...cleanUpdatePayload,
    role: preservedRole,
    updatedAt: now,
  };

  try {
    const userRef = doc(db, 'users', currentUser.id);
    await updateDoc(userRef, cleanUpdatePayload);
    saveTabUserSession(updatedUser);
    return updatedUser;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${currentUser.id}`);
    throw err;
  }
}

/**
 * Inativa o próprio perfil do usuário no Firestore e encerra a sessão apenas na aba atual.
 */
export async function deactivateCurrentUserProfile(currentUser: User): Promise<void> {
  const now = Date.now();
  try {
    await useLogStore
      .getState()
      .addLog({
        acao: 'CONTA_EXCLUIDA_USUARIO',
        usuarioId: currentUser.id,
        usuarioNome: currentUser.nome,
        entidade: 'USERS',
        detalhes: `O usuário ${currentUser.nome} (${currentUser.email}) solicitou a exclusão/inativação do próprio perfil.`,
      })
      .catch(() => {});

    const userRef = doc(db, 'users', currentUser.id);
    await updateDoc(userRef, {
      inativo: true,
      bloqueado: true,
      updatedAt: now,
    });

    clearTabUserSession();
    await firebaseSignOut(auth).catch(() => {});
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${currentUser.id}`);
  }
}

export interface TabAuthSubscriptionCallbacks {
  onAuthenticated: (user: User) => void;
  onUnauthenticated: (reasonError?: string) => void;
  onError: (errorMessage: string) => void;
}

/**
 * Assina mudanças de autenticação exclusivamente da instância `auth` da aba atual (`browserSessionPersistence`)
 * após validar o isolamento de aba (`ensureTabIsolationReady`), mantendo sincronização em tempo real do perfil `users/{uid}`.
 */
export function subscribeToTabAuthState(callbacks: TabAuthSubscriptionCallbacks): () => void {
  let unsubscribeUserSnapshot: (() => void) | null = null;
  let unsubscribeAuthListener: (() => void) | null = null;
  let disposed = false;

  void ensureTabIsolationReady().finally(() => {
    if (disposed) return;

    unsubscribeAuthListener = onAuthStateChanged(
      auth,
      (firebaseUser) => {
        if (disposed) return;

        if (unsubscribeUserSnapshot) {
          try {
            unsubscribeUserSnapshot();
          } catch {
            // Ignora falha de encerramento de listener anterior
          }
          unsubscribeUserSnapshot = null;
        }

        if (!firebaseUser) {
          clearTabUserSession();
          callbacks.onUnauthenticated();
          return;
        }

        const activeUid = firebaseUser.uid;
        const userRef = doc(db, 'users', activeUid);

        unsubscribeUserSnapshot = onSnapshot(
          userRef,
          (docSnap) => {
            if (disposed || auth.currentUser?.uid !== activeUid) return;

            if (docSnap.exists()) {
              const data = hydrateUserDocument(docSnap.data(), activeUid);
              if (data.bloqueado || data.inativo) {
                clearTabUserSession();
                callbacks.onUnauthenticated(
                  'Sua conta está bloqueada ou inativa pela administração.'
                );
                void firebaseSignOut(auth).catch(() => {});
              } else {
                saveTabUserSession(data);
                callbacks.onAuthenticated(data);
              }
            } else {
              // Evita corrida durante `registerWithEmail` antes do `setDoc` concluir
              if (isRegisteringInTab || registeringUidInTab === activeUid) {
                return;
              }

              // Se a aba atual já possui o perfil recém-cadastrado para este UID, preserva seu papel exato
              const existingTabUser = loadTabUserSession();
              if (existingTabUser && existingTabUser.id === activeUid) {
                callbacks.onAuthenticated(existingTabUser);
                return;
              }

              const defaultUserData = buildDefaultUserDocument(
                activeUid,
                firebaseUser.email || '',
                firebaseUser.displayName
              );
              setDoc(userRef, stripUndefinedFields(defaultUserData))
                .then(() => {
                  if (disposed || auth.currentUser?.uid !== activeUid) return;
                  saveTabUserSession(defaultUserData);
                  callbacks.onAuthenticated(defaultUserData);
                })
                .catch((err) => {
                  console.error('Failed to auto-create user document:', err);
                  const cached = loadTabUserSession();
                  if (!cached || cached.id !== activeUid) {
                    callbacks.onUnauthenticated();
                  }
                });
            }
          },
          (err) => {
            if (disposed || auth.currentUser?.uid !== activeUid) return;
            try {
              handleFirestoreError(err, OperationType.GET, `users/${activeUid}`);
            } catch {
              // Erro estruturado registrado para diagnóstico
            }
            const cached = loadTabUserSession();
            if (cached && cached.id === activeUid) {
              callbacks.onAuthenticated(cached);
            } else {
              callbacks.onError('Erro ao sincronizar perfil do usuário.');
            }
          }
        );
      },
      (err: any) => {
        if (disposed) return;
        console.error('Auth state change error:', err);
        callbacks.onError(translateAuthError(err?.code, err?.message));
      }
    );
  });

  return () => {
    disposed = true;
    if (unsubscribeUserSnapshot) {
      try {
        unsubscribeUserSnapshot();
      } catch {
        // Ignora falha de encerramento de listener
      }
      unsubscribeUserSnapshot = null;
    }
    if (unsubscribeAuthListener) {
      try {
        unsubscribeAuthListener();
      } catch {
        // Ignora falha de encerramento de listener
      }
      unsubscribeAuthListener = null;
    }
  };
}
