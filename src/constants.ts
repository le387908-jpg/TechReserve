/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PunishmentCategory, RealtimeSpaceStatus, SpaceCategory, UserVinculo } from './types';

export const ADMIN_AUTH_CODE = '051325';

export const COLORS = {
  primary: '#8B0000', // Vinho Institucional
  secondary: '#1A1A1A', // Preto
  background: '#FFFFFF', // Branco
  gray: {
    50: '#F9FAFB',
    100: '#F3F4F6',
    200: '#E5E7EB',
    300: '#D1D5DB',
    400: '#9CA3AF',
    500: '#6B7280',
    600: '#4B5563',
    700: '#374151',
    800: '#1F2937',
    900: '#111827',
  }
};

export const REALTIME_SPACE_STATUS_LABELS: Record<RealtimeSpaceStatus, string> = {
  DISPONIVEL: 'Disponível',
  RESERVADO: 'Reservado',
  EM_USO: 'Em Uso',
  MANUTENCAO: 'Em Manutenção',
};

export const SPACE_CATEGORY_LABELS: Record<SpaceCategory, string> = {
  SALA: 'Sala de Aula',
  LABORATORIO: 'Laboratório',
  AUDITORIO: 'Auditório',
  ESPECIAL: 'Espaço Especial',
};

export const PUNISHMENT_CATEGORY_LABELS: Record<PunishmentCategory, string> = {
  NO_SHOW: 'No-Show (Ausência sem cancelamento)',
  MAU_USO: 'Mau uso do espaço ou equipamentos',
  ATRASO: 'Atraso na desocupação do ambiente',
  DESCUMPRIMENTO_NORMAS: 'Descumprimento de normas institucionais',
  OUTRO: 'Outro motivo disciplinar',
};

export const USER_VINCULO_LABELS: Record<UserVinculo, string> = {
  ALUNO: 'Aluno / Estudante',
  SERVIDOR: 'Servidor / Docente',
  COORDENACAO: 'Coordenação / ADM',
};

export const TICKET_STATUS_LABELS = {
  ABERTO: 'Aberto',
  EM_ANALISE: 'Em Análise',
  EM_ANDAMENTO: 'Em Andamento',
  RESOLVIDO: 'Resolvido',
  FECHADO: 'Fechado',
};

export const TICKET_PRIORITY_LABELS = {
  BAIXA: 'Baixa',
  MEDIA: 'Média',
  ALTA: 'Alta',
  URGENTE: 'Urgente',
};

export const RESERVATION_STATUS_LABELS = {
  PENDENTE: 'Pendente',
  CONFIRMADA: 'Confirmada',
  CANCELADA: 'Cancelada',
  CONCLUIDA: 'Concluída',
  PUNIDA: 'No-Show / Punida',
};

export const ROOM_STATUS_LABELS = {
  ATIVO: 'Disponível',
  DISPONIVEL: 'Disponível',
  RESERVADO: 'Reservado',
  EM_USO: 'Em Uso',
  INATIVO: 'Inativo',
  MANUTENCAO: 'Em Manutenção',
};
