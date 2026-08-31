import type { IscConfig } from "@/lib/isc/config";

export type { IscConfig };

export interface IscTaskRef {
  id: string;
  name?: string;
  type?: string;
}

export interface IscTaskStatus {
  id: string;
  name?: string;
  /** ISC returns an ISO datetime when the task finishes, not a boolean. */
  completed?: boolean | string;
  progress?: string;
  completionStatus?: string;
  /**
   * Where beta /task-status puts failure detail — there is no `errors` field on
   * that response, so this is the only place a task's reason for failing shows up.
   */
  messages?: Array<{
    type?: string;
    key?: string;
    localizedText?: { locale?: string; text?: string };
    [key: string]: unknown;
  }>;
  attributes?: Record<string, unknown>;
  errors?: Array<string | Record<string, unknown>>;
  warnings?: Array<string | Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AttributeMapping {
  identityAttribute: string;
  accountAttribute: string;
}

export interface MachineAccountTransformDefinition {
  type: string;
  attributes: Record<string, string>;
  id?: string;
}

export interface MachineAccountMappingTarget {
  type: string;
  attributeName: string;
  sourceId?: string;
}

export interface MachineAccountAttributeMapping {
  transformDefinition: MachineAccountTransformDefinition;
  target: MachineAccountMappingTarget;
}

export interface IscAccountSummary {
  id: string;
  name?: string;
  nativeIdentity?: string;
  sourceId?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface IscMachineAccountSummary {
  id: string;
  name?: string;
  nativeIdentity?: string;
  machineIdentityId?: string;
  sourceId?: string;
  [key: string]: unknown;
}

export interface DemoVerifyResult {
  accounts: IscAccountSummary[];
  machineAccounts: IscMachineAccountSummary[];
  entitlements: unknown[];
  accountCount: number;
  machineAccountCount: number;
  entitlementCount: number;
  accessReady: boolean;
  hints: string[];
}

export interface AggregationStartResult {
  taskId: string | null;
  raw: unknown;
}
