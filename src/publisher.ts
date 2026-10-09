import type { AssetRow } from './service.js';
import type { Role, PrimaryAttachmentsMode } from './shared/contracts.js';

export interface PublishRequest {
  role: Role; text: string; attachments: string[]; operationKey: string; permanentDonut: true;
  candidatePostId?: string;
  publishAt?: number;
  primaryAttachmentsMode?: PrimaryAttachmentsMode;
}
export interface PublishResult { postId: string; url: string }
export interface PublicationDetails {
  method?: string; apiErrorCode?: number; httpStatus?: number;
  expectedOwnerId?: number; actualOwnerId?: number;
  responseFields?: { server: string; photo: string; hash: string };
}
export type Reconciliation = { status: 'posted'; result: PublishResult } | { status: 'absent' | 'unknown' };
export interface PublisherStatus {
  state: string; code?: string; groupId?: number; groupName?: string; groupUrl?: string; apiErrorCode?: number;
  donutReference?: { postId: string; found?: boolean; isDonut?: boolean; paidDuration?: number;
    durationSource?: 'api' | 'owner_confirmation' };
}

export interface Publisher {
  // This gate must be true only after authorization, permanent Donut and photo privacy have been verified.
  available(): boolean;
  check?(): Promise<void>;
  status?(): PublisherStatus;
  scheduledTimes?(): Promise<number[]>;
  upload(asset: AssetRow, role: Role): Promise<string>;
  publish(request: PublishRequest): Promise<PublishResult>;
  reconcile(request: PublishRequest): Promise<Reconciliation>;
}
export class PublicationError extends Error {
  constructor(public kind: 'transient' | 'authorization' | 'permanent' | 'unknown',
    public code?: string, public result?: PublishResult, public details?: PublicationDetails) { super(kind); }
}
export class BlockedPublisher implements Publisher {
  available() { return false; }
  async upload(): Promise<string> { throw new PublicationError('permanent'); }
  async publish(): Promise<PublishResult> { throw new PublicationError('permanent'); }
  async reconcile(): Promise<Reconciliation> { return { status: 'unknown' }; }
}
