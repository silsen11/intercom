/**
 * RiderCom Mesh Pro - Types and Protocol Interfaces
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface Peer {
  id: string;
  nick: string;
  isTalking?: boolean;
  pc?: any;
  stream?: any;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface SignalingConfigMessage {
  type: 'CONFIG';
  clientId: string;
  roomId: string;
  nick: string;
  iceServers: IceServer[];
}

export interface SignalingPeersMessage {
  type: 'PEERS';
  peers: Array<{ id: string; nick: string; isTalking?: boolean }>;
  you: { id: string; nick: string; room: string };
}

export interface SignalingPeerJoinedMessage {
  type: 'PEER_JOINED';
  id: string;
  nick: string;
}

export interface SignalingPeerLeftMessage {
  type: 'PEER_LEFT';
  id: string;
  nick: string;
}

export interface SignalingOfferMessage {
  type: 'OFFER';
  fromId: string;
  fromNick: string;
  targetId: string;
  sdp: string;
}

export interface SignalingAnswerMessage {
  type: 'ANSWER';
  fromId: string;
  fromNick: string;
  targetId: string;
  sdp: string;
}

export interface SignalingIceMessage {
  type: 'ICE_CANDIDATE';
  fromId: string;
  targetId: string;
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

export interface SignalingTalkStateMessage {
  type: 'TALK_STATE';
  isTalking: boolean;
}

export interface SignalingPeerTalkStateMessage {
  type: 'PEER_TALK_STATE';
  peerId: string;
  isTalking: boolean;
}

export interface SignalingPongMessage {
  type: 'PONG';
  ts: number;
  serverTime: number;
}

export type SignalingMessage =
  | SignalingConfigMessage
  | SignalingPeersMessage
  | SignalingPeerJoinedMessage
  | SignalingPeerLeftMessage
  | SignalingOfferMessage
  | SignalingAnswerMessage
  | SignalingIceMessage
  | SignalingTalkStateMessage
  | SignalingPeerTalkStateMessage
  | SignalingPongMessage;
