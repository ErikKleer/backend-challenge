import { InvalidMessageStateError } from "../../shared/domain/domain.error";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Registro de deduplicação de uma mensagem consumida. A identidade é `(consumerName, messageId)`;
 * o `payloadHash` permite detectar o mesmo messageId reentregue com conteúdo diferente.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  public static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || typeof props.messageId !== "string") {
      throw new InvalidMessageStateError("Inbox messageId must be a non-empty string");
    }
    if (!props.consumerName || typeof props.consumerName !== "string") {
      throw new InvalidMessageStateError("Inbox consumerName must be a non-empty string");
    }
    if (typeof props.payloadHash !== "string" || !SHA256_HEX_PATTERN.test(props.payloadHash)) {
      throw new InvalidMessageStateError("Inbox payloadHash must be a lowercase SHA-256 hex string");
    }

    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  public static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  public get processedAt(): Date | undefined {
    return this._processedAt;
  }

  public isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  public markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(
        `Inbox message '${this.consumerName}/${this.messageId}' is already processed`,
      );
    }
    this._processedAt = at;
  }
}
