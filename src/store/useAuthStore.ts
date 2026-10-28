/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  deleteUser,
} from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../services/firebase/config';
import { User, UserRole, UserVinculo, CalendarCourse } from '../types';
import { OperationType, handleFirestoreError, withRetry } from '../services/firebase/utils';
import { normalizeDateToISO } from '../utils/dateUtils';
import {
  formatPhone,
  getPhoneValidationMessage,
  sanitizePhone,
  validatePhone,
} from '../utils/formatters';
import { useLogStore } from './useLogStore';

interface AuthState {
  user: User | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;

  signIn: (email: string, pass: string) => Promise<void>;
  signUp: (data: {
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
  }) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<void>;
  deactivateMyProfile: () => Promise<void>;
  setInitialized: (val: boolean) => void;
}

function translateAuthError(code: string, fallback: string): string {
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
      return fallback;
  }
}

/**
 * Normaliza campos legados e garante sincronização entre os campos em português (`nome`, `curso`, `semestre`)
 * e os campos padronizados do perfil (`name`, `phone`, `phoneFormatted`, `course`, `semester`, `whatsappNotificationsEnabled`).
 */
function hydrateUserDocument(raw: Record<string, any>, fallbackUid: string): User {
  const nome = raw.nome || raw.name || 'Usuário';
  const curso = raw.curso || raw.course;
  const semestre = raw.semestre ?? raw.semester;
  const sanitizedPhone = sanitizePhone(raw.phone || raw.phoneFormatted || raw.telefone || '');
  const formattedPhone = sanitizedPhone ? formatPhone(sanitizedPhone) : '';

  return {
    ...(raw as User),
    id: raw.id || fallbackUid,
    nome,
    name: nome,
    phone: sanitizedPhone,
    phoneFormatted: formattedPhone,
    whatsappNotificationsEnabled: raw.whatsappNotificationsEnabled !== false,
    blockedDate: raw.blockedDate ? normalizeDateToISO(raw.blockedDate) : '',
    ...(curso ? { curso, course: curso } : {}),
    ...(semestre !== undefined ? { semestre, semester: semestre } : {}),
    dataNascimento: raw.dataNascimento ? normalizeDateToISO(raw.dataNascimento) : raw.dataNascimento,
  };
}

let isRegistering = false;

export const useAuthStore = create<AuthState>((set, get) => {
  let unsubscribeSnapshot: (() => void) | null = null;

  onAuthStateChanged(
    auth,
    async (firebaseUser) => {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }

      if (firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);

        unsubscribeSnapshot = onSnapshot(
          userRef,
          (docSnap) => {
            if (docSnap.exists()) {
              const data = hydrateUserDocument(docSnap.data(), firebaseUser.uid);
              if (data.bloqueado || data.inativo) {
                set({
                  user: null,
                  loading: false,
                  initialized: true,
                  error: 'Sua conta está bloqueada ou inativa pela administração.',
                });
                signOut(auth);
              } else {
                set({ user: data, loading: false, initialized: true, error: null });
              }
            } else {
              if (isRegistering) {
                return;
              }
              const userEmail = firebaseUser.email || '';
              const userLower = userEmail.toLowerCase();
              const adminEmails = [
                'negreirosmikaella@gmail.com',
                'le387908@gmail.com',
                'fatec.taquaritinga.2024@gmail.com',
              ];
              const isAdminRole = adminEmails.includes(userLower);
              const resolvedName =
                firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'Usuário';

              const defaultUserData: User = {
                id: firebaseUser.uid,
                nome: resolvedName,
                name: resolvedName,
                email: userEmail,
                phone: '',
                phoneFormatted: '',
                whatsappNotificationsEnabled: true,
                ra: '',
                tipoVinculo: isAdminRole ? 'COORDENACAO' : 'ALUNO',
                dataNascimento: '2000-01-01',
                role: isAdminRole ? 'ADMIN' : 'USUARIO',
                aprovado: true,
                bloqueado: false,
                blockedDate: '',
                motivoPunicao: '',
                ...(isAdminRole
                  ? {}
                  : { curso: 'GTI', course: 'GTI', semestre: 1, semester: 1 }),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };

              setDoc(userRef, defaultUserData)
                .then(() => {
                  set({ user: defaultUserData, loading: false, initialized: true, error: null });
                })
                .catch((err) => {
                  console.error('Failed to auto-create user document:', err);
                  const currentUser = get().user;
                  if (!currentUser) {
                    set({ user: null, loading: false, initialized: true });
                  }
                });
            }
          },
          (err) => {
            console.error('Auth snapshot error:', err);
            set({ loading: false, initialized: true });
          }
        );
      } else {
        set({ user: null, loading: false, initialized: true });
      }
    },
    (err: any) => {
      console.error('Auth state change error:', err);
      set({
        loading: false,
        initialized: true,
        error: translateAuthError(err.code, err.message),
      });
    }
  );

  setTimeout(() => {
    if (!get().initialized) {
      set({ loading: false, initialized: true });
    }
  }, 10000);

  return {
    user: null,
    loading: true,
    initialized: false,
    error: null,

    setInitialized: (val: boolean) => set({ initialized: val }),

    signIn: async (email, pass) => {
      set({ loading: true, error: null });
      const cleanEmail = email.trim().toLowerCase();
      try {
        const userCredential = await withRetry(() =>
          signInWithEmailAndPassword(auth, cleanEmail, pass)
        );

        const existingUser = get().user;
        if (existingUser && existingUser.id === userCredential.user.uid) {
          if (existingUser.bloqueado || existingUser.inativo) {
            await signOut(auth);
            throw new Error('Sua conta está bloqueada ou suspensa pela administração.');
          }
          set({ loading: false });
          return;
        }

        const userRef = doc(db, 'users', userCredential.user.uid);
        const docSnap = await getDoc(userRef);
        let userData: User;
        if (docSnap.exists()) {
          userData = hydrateUserDocument(docSnap.data(), userCredential.user.uid);
        } else {
          const userEmail = userCredential.user.email || cleanEmail;
          const userLower = userEmail.toLowerCase();
          const adminEmails = [
            'negreirosmikaella@gmail.com',
            'le387908@gmail.com',
            'fatec.taquaritinga.2024@gmail.com',
          ];
          const isAdminRole = adminEmails.includes(userLower);
          const resolvedName =
            userCredential.user.displayName ||
            userCredential.user.email?.split('@')[0] ||
            'Usuário';

          userData = {
            id: userCredential.user.uid,
            nome: resolvedName,
            name: resolvedName,
            email: userEmail,
            phone: '',
            phoneFormatted: '',
            whatsappNotificationsEnabled: true,
            ra: '',
            tipoVinculo: isAdminRole ? 'COORDENACAO' : 'ALUNO',
            dataNascimento: '2000-01-01',
            role: isAdminRole ? 'ADMIN' : 'USUARIO',
            aprovado: true,
            bloqueado: false,
            blockedDate: '',
            motivoPunicao: '',
            ...(isAdminRole
              ? {}
              : { curso: 'GTI', course: 'GTI', semestre: 1, semester: 1 }),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await setDoc(userRef, userData);
        }

        if (userData.bloqueado || userData.inativo) {
          await signOut(auth);
          throw new Error('Sua conta está bloqueada ou suspensa pela administração.');
        }
        set({ user: userData, loading: false, initialized: true });
      } catch (err: any) {
        const message = translateAuthError(err.code, err.message);
        set({ error: message, loading: false });
        throw new Error(message);
      }
    },

    signUp: async ({
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
    }) => {
      set({ loading: true, error: null });
      isRegistering = true;
      const cleanEmail = email.trim().toLowerCase();
      const submittedCode = (code || '').trim();

      // 1. Valida obrigatoriamente o formato de 11 dígitos do telefone antes de criar o usuário no Firebase Auth
      if (!validatePhone(phone)) {
        const validationError =
          getPhoneValidationMessage(phone) ||
          'O número de telefone deve possuir 11 dígitos no formato (00) 00000-0000.';
        isRegistering = false;
        set({ loading: false, error: validationError });
        throw new Error(validationError);
      }

      const sanitizedPhone = sanitizePhone(phone);
      const formattedPhone = formatPhone(sanitizedPhone);

      if (role === 'ADMIN' && !submittedCode) {
        isRegistering = false;
        set({ loading: false });
        throw new Error('Informe o código de autorização administrativa (code-auth).');
      }

      let createdFirebaseUser: any = null;

      try {
        const credential = await withRetry(() =>
          createUserWithEmailAndPassword(auth, cleanEmail, pass)
        );
        createdFirebaseUser = credential.user;

        const isAdminTarget = role === 'ADMIN';
        const resolvedVinculo: UserVinculo = isAdminTarget
          ? 'COORDENACAO'
          : tipoVinculo || 'ALUNO';
        const cleanName = nome.trim().slice(0, 120);
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
          role: isAdminTarget ? 'ADMIN' : 'USUARIO',
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

        await setDoc(doc(db, 'users', createdFirebaseUser.uid), userData);

        await useLogStore.getState().addLog({
          acao: isAdminTarget ? 'CADASTRO_NOVO_ADMIN' : 'CADASTRO_NOVO_USUARIO',
          usuarioId: createdFirebaseUser.uid,
          usuarioNome: userData.nome,
          entidade: 'USERS',
          detalhes: `Novo perfil ${isAdminTarget ? 'ADMINISTRATIVO' : resolvedVinculo} cadastrado (${cleanEmail} · WhatsApp: ${formattedPhone}).`,
        });

        set({ user: userData, loading: false, initialized: true });
      } catch (err: any) {
        if (
          createdFirebaseUser &&
          role === 'ADMIN' &&
          (err?.code === 'permission-denied' ||
            String(err?.message || '').toLowerCase().includes('permission') ||
            String(err?.message || '').toLowerCase().includes('insufficient'))
        ) {
          try {
            await deleteUser(createdFirebaseUser);
          } catch {
            await signOut(auth);
          }
          const msg =
            'Código de autorização administrativa (code-auth) inválido ou cadastro de novos administradores desativado.';
          set({ error: msg, loading: false });
          throw new Error(msg);
        }

        const message = translateAuthError(err.code, err.message);
        set({ error: message, loading: false });
        throw new Error(message);
      } finally {
        isRegistering = false;
      }
    },

    signOut: async () => {
      await signOut(auth);
      set({ user: null });
    },

    resetPassword: async (email) => {
      await sendPasswordResetEmail(auth, email);
    },

    updateProfile: async (data) => {
      const currentUser = get().user;
      if (!currentUser) return;

      const sanitizedData: Record<string, any> = { ...data };
      if (currentUser.role !== 'ADMIN') {
        delete sanitizedData.curso;
        delete sanitizedData.course;
        delete sanitizedData.role;
        delete sanitizedData.bloqueado;
        delete sanitizedData.inativo;
        delete sanitizedData.aprovado;
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
      set({ user: { ...currentUser, ...sanitizedData, updatedAt: now } });

      try {
        const userRef = doc(db, 'users', currentUser.id);
        await updateDoc(userRef, { ...sanitizedData, updatedAt: now });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${currentUser.id}`);
      }
    },

    deactivateMyProfile: async () => {
      const currentUser = get().user;
      if (!currentUser) return;

      const now = Date.now();
      try {
        await useLogStore.getState().addLog({
          acao: 'CONTA_EXCLUIDA_USUARIO',
          usuarioId: currentUser.id,
          usuarioNome: currentUser.nome,
          entidade: 'USERS',
          detalhes: `O usuário ${currentUser.nome} (${currentUser.email}) solicitou a exclusão/inativação do próprio perfil.`,
        });

        const userRef = doc(db, 'users', currentUser.id);
        await updateDoc(userRef, {
          inativo: true,
          bloqueado: true,
          updatedAt: now,
        });

        await signOut(auth);
        set({ user: null });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${currentUser.id}`);
      }
    },
  };
});
