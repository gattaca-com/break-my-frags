export type Gateway = {
  url: string;
  address: string;
  ping?: number; // Average ping in ms
};

export type FutureGateway = {
  url: string;
  address: string;
  blockNumber: number;
};

export type FutureGatewayResponse = {
  jsonrpc: string;
  result: [number, string, string, string];
  id: number;
};

export type RegisteredGatewaysResponse = {
  jsonrpc: string;
  result: [string, string, string][];
  id: number;
}; 