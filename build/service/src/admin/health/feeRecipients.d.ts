export interface ClientFeeRecipients {
  validators: number;
  checked: number;
  missing: number;
}
export interface ValidatorClient {
  name: string;
  keymanager: string;
  beacon: string;
  browserReadable: boolean;
}
export declare const VALIDATOR_CLIENTS: ReadonlyArray<ValidatorClient>;
export declare const MAX_KEYS_CHECKED: number;
export declare function readClientFeeRecipients(client: ValidatorClient, fetchImpl?: typeof fetch): Promise<ClientFeeRecipients | null>;
export declare function fetchFeeRecipients(
  packages: ReadonlyArray<{ name: string; running?: boolean }>,
  fetchImpl?: typeof fetch,
  opts?: { browser?: boolean },
): Promise<Record<string, ClientFeeRecipients> | null>;
