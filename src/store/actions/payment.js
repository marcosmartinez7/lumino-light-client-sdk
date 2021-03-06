import {
  CREATE_PAYMENT,
  ADD_PENDING_PAYMENT_MESSAGE,
  DELETE_ALL_PENDING_PAYMENTS,
  MESSAGE_POLLING_START,
  MESSAGE_POLLING_STOP,
  SET_PAYMENT_SECRET,
  UPDATE_NON_CLOSING_BP,
  PAYMENT_CREATION_ERROR,
} from "./types";
import client from "../../apiRest";
import resolver from "../../utils/handlerResolver";
import generateHashes from "../../utils/generateHashes";
import {
  getDataToSignForLockedTransfer,
  getDataToSignForDelivered,
  getDataToSignForRevealSecret,
  getDataToSignForBalanceProof,
  getDataToSignForProcessed,
  getDataToSignForSecretRequest,
  getDataToSignForNonClosingBalanceProof,
} from "../../utils/pack";
import { validateLockedTransfer } from "../../utils/validators";
import { getChannelsState } from "../functions";
import { ethers } from "ethers";
import JSONbig from "json-bigint";
import BigNumber from "bignumber.js";
import { MessageType } from "../../config/messagesConstants";
import { saveLuminoData } from "./storage";
import { getLatestChannelByPartnerAndToken } from "../functions/channels";
import { searchTokenDataInChannels } from "../functions/tokens";

/**
 * Create a payment.
 * @param {string} amount- Amount to pay
 * @param {string} address -  The address of the channel creator
 * @param {string} partner -  The partner address
 * @param {string} token_address -  The address of the lumino token
 */
export const createPayment = params => async (dispatch, getState, lh) => {
  try {
    const { getAddress, bigNumberify } = ethers.utils;
    const { partner, token_address, amount } = params;
    const { address } = getState().client;
    const hashes = generateHashes();
    const { secrethash, hash: secret } = hashes;
    const channel = getLatestChannelByPartnerAndToken(partner, token_address);
    // Check for sufficient funds
    const actualBalance = bigNumberify(channel.offChainBalance);
    if (actualBalance.lt(amount)) {
      console.error("Insufficient funds for payment");
      // TODO: Add a callback for this
      dispatch({
        type: PAYMENT_CREATION_ERROR,
        reason: `Insufficient funds for payment`,
      });
      return null;
    }
    const requestBody = {
      creator_address: address,
      partner_address: partner,
      amount,
      token_address,
      secrethash,
    };
    const urlCreate = "payments_light/create";
    const res = await client.post(urlCreate, requestBody, {
      transformResponse: res => JSONbig.parse(res),
    });
    const { message, message_id, message_order } = { ...res.data };
    const messageWithHash = {
      ...message,
      lock: {
        ...message.lock,
        secrethash,
      },
    };
    let signature;
    const dataToSign = ethers.utils.arrayify(
      getDataToSignForLockedTransfer(messageWithHash)
    );
    try {
      signature = await resolver(dataToSign, lh, true);
    } catch (resolverError) {
      throw resolverError;
    }
    const channels = getChannelsState();
    validateLockedTransfer(message, requestBody, channels);
    const dataToPut = {
      message_id,
      message_order,
      receiver: getAddress(messageWithHash.target),
      sender: getAddress(messageWithHash.initiator),
      message: {
        ...messageWithHash,
        signature,
      },
    };
    const urlPut = "payments_light";
    await client.put(urlPut, dataToPut, {
      transformResponse: res => JSONbig.parse(res),
    });
    const { tokenName, tokenSymbol } = searchTokenDataInChannels(token_address);
    dispatch({
      type: CREATE_PAYMENT,
      payment: {
        messages: { 1: { ...dataToPut, message_order: 1 } },
        message_order: 1,
        secret,
        partner: message.target,
        paymentId: `${dataToPut.message_id}`,
        initiator: message.initiator,
        amount: message.lock.amount,
        secret_hash: secrethash,
        channelId: dataToPut.message.channel_identifier,
        token: token_address,
        tokenName,
        tokenSymbol,
        tokenNetworkAddress: dataToPut.message.token_network_address,
        chainId: dataToPut.message.chain_id,
      },
      paymentId: `${dataToPut.message_id}`,
      channelId: dataToPut.message.channel_identifier,
      token: token_address,
    });
    const allData = getState();
    return await lh.storage.saveLuminoData(allData);
  } catch (apiError) {
    throw apiError;
  }
};

export const clearAllPendingPayments = () => async (dispatch, getState, lh) => {
  dispatch(deleteAllPendingPayments());
  const allData = getState();
  return await lh.storage.saveLuminoData(allData);
};

export const mockPulling = () => async (dispatch, getState, lh) => {
  dispatch({ type: MESSAGE_POLLING_START });
};

export const mockStopPulling = () => async (dispatch, getState, lh) => {
  dispatch({ type: MESSAGE_POLLING_STOP });
};

export const deleteAllPendingPayments = () => dispatch =>
  dispatch({
    type: DELETE_ALL_PENDING_PAYMENTS,
  });

export const addPendingPaymentMessage = (
  paymentId,
  messageOrder,
  message
) => dispatch =>
  dispatch({
    type: ADD_PENDING_PAYMENT_MESSAGE,
    paymentId,
    messageOrder,
    message,
  });

const getRandomBN = () => {
  const randomBN = BigNumber.random(18).toString();
  return new BigNumber(randomBN.split(".")[1]).toString();
};
export const putDelivered = (
  message,
  payment,
  order = 4,
  isReception = false
) => async (dispatch, getState, lh) => {
  const sender = isReception ? payment.partner : payment.initiator;
  const receiver = isReception ? payment.initiator : payment.partner;
  const { getAddress } = ethers.utils;
  const body = {
    message_id: payment.paymentId,
    message_order: order,
    sender: getAddress(sender),
    receiver: getAddress(receiver),
    message: {
      type: MessageType.DELIVERED,
      delivered_message_identifier: message.message_identifier,
    },
  };
  const dataToSign = getDataToSignForDelivered(body.message);
  let signature = "";
  try {
    signature = await resolver(dataToSign, lh, true);
  } catch (resolverError) {
    throw resolverError;
  }
  body.message.signature = signature;
  try {
    dispatch(
      addPendingPaymentMessage(payment.paymentId, body.message_order, {
        message: body.message,
        message_order: body.message_order,
      })
    );
    const urlPut = "payments_light";
    await client.put(urlPut, body, {
      transformResponse: res => JSONbig.parse(res),
    });

    dispatch(saveLuminoData());
  } catch (reqEx) {
    console.error("reqExDelivered", reqEx);
  }
};

export const putProcessed = (msg, payment, order = 3) => async (
  dispatch,
  getState,
  lh
) => {
  const { getAddress } = ethers.utils;
  const body = {
    message_id: payment.paymentId,
    message_order: order,
    sender: getAddress(payment.partner),
    receiver: getAddress(payment.initiator),
    message: {
      type: MessageType.PROCESSED,
      message_identifier: msg.message_identifier,
    },
  };
  const dataToSign = getDataToSignForProcessed(body.message);
  let signature = "";
  try {
    signature = await resolver(dataToSign, lh, true);
  } catch (resolverError) {
    throw resolverError;
  }
  body.message.signature = signature;
  try {
    dispatch(
      addPendingPaymentMessage(payment.paymentId, body.message_order, {
        message: body.message,
        message_order: body.message_order,
      })
    );
    const urlPut = "payments_light";
    await client.put(urlPut, body, {
      transformResponse: res => JSONbig.parse(res),
    });
    dispatch(saveLuminoData());
  } catch (reqEx) {
    console.error("reqEx Put SecretReveal", reqEx);
  }
};

export const putSecretRequest = (msg, payment) => async (
  dispatch,
  getState,
  lh
) => {
  const { getAddress } = ethers.utils;
  const body = {
    message_id: payment.paymentId,
    message_order: 5,
    sender: getAddress(payment.initiator),
    receiver: getAddress(payment.partner),
    message: {
      type: MessageType.SECRET_REQUEST,
      message_identifier: msg.message_identifier,
      payment_identifier: payment.paymentId,
      amount: payment.amount,
      expiration: msg.expiration,
      secrethash: payment.secret_hash,
    },
  };
  const dataToSign = getDataToSignForSecretRequest(body.message);
  let signature = "";
  try {
    signature = await resolver(dataToSign, lh, true);
  } catch (resolverError) {
    throw resolverError;
  }
  body.message.signature = signature;
  try {
    dispatch(
      addPendingPaymentMessage(payment.paymentId, body.message_order, {
        message: body.message,
        message_order: body.message_order,
      })
    );
    const urlPut = "payments_light";
    await client.put(urlPut, body, {
      transformResponse: res => JSONbig.parse(res),
    });
    dispatch(saveLuminoData());
  } catch (reqEx) {
    console.error("reqEx Put SecretReveal", reqEx);
  }
};

export const putRevealSecret = (
  payment,
  message_identifier = getRandomBN(),
  order = 7,
  isReception = false
) => async (dispatch, getState, lh) => {
  const { getAddress } = ethers.utils;
  const sender = isReception
    ? getAddress(payment.partner)
    : getAddress(payment.initiator);
  const receiver = isReception
    ? getAddress(payment.initiator)
    : getAddress(payment.partner);

  const body = {
    message_id: payment.paymentId,
    message_order: order,
    sender,
    receiver,
    message: {
      type: MessageType.REVEAL_SECRET,
      message_identifier,
      secret: payment.secret,
    },
  };
  const dataToSign = getDataToSignForRevealSecret(body.message);
  let signature = "";
  try {
    signature = await resolver(dataToSign, lh, true);
  } catch (resolverError) {
    throw resolverError;
  }
  body.message.signature = signature;
  try {
    dispatch(
      addPendingPaymentMessage(payment.paymentId, body.message_order, {
        message: body.message,
        message_order: body.message_order,
      })
    );
    const urlPut = "payments_light";
    await client.put(urlPut, body, {
      transformResponse: res => JSONbig.parse(res),
    });
    dispatch(saveLuminoData());
  } catch (reqEx) {
    console.error("reqEx Put SecretReveal", reqEx);
  }
};

export const putBalanceProof = (message, payment) => async (
  dispatch,
  getState,
  lh
) => {
  const { getAddress } = ethers.utils;
  const { signature: oldSignature, ...data } = message;
  const dataToSign = getDataToSignForBalanceProof(data);
  let signature = "";
  try {
    signature = await resolver(dataToSign, lh, true);
  } catch (resolverError) {
    throw resolverError;
  }
  const body = {
    message_id: payment.paymentId,
    message_order: 11,
    sender: getAddress(payment.initiator),
    receiver: getAddress(payment.partner),
    message: {
      ...data,
      signature,
    },
  };
  try {
    dispatch(
      addPendingPaymentMessage(payment.paymentId, body.message_order, {
        message: body.message,
        message_order: body.message_order,
      })
    );
    const urlPut = "payments_light";
    await client.put(urlPut, body, {
      transformResponse: res => JSONbig.parse(res),
    });
    dispatch(saveLuminoData());
  } catch (reqEx) {
    console.error("reqEx Put SecretReveal", reqEx);
  }
};

export const putNonClosingBalanceProof = (message, payment) => async (
  dispatch,
  getState,
  lh
) => {
  const { getAddress } = ethers.utils;
  const dataToSign = getDataToSignForNonClosingBalanceProof(message);
  let signature = "";
  try {
    signature = await resolver(dataToSign, lh, true);
  } catch (resolverError) {
    throw resolverError;
  }
  const body = {
    sender: getAddress(payment.partner),
    light_client_payment_id: payment.paymentId,
    secret_hash: payment.secret_hash,
    nonce: message.nonce,
    channel_id: payment.channelId,
    token_network_address: getAddress(payment.tokenNetworkAddress),
    lc_bp_signature: signature,
    partner_balance_proof: message,
  };
  try {
    const urlPut = "watchtower";
    await client.put(urlPut, body, {
      transformResponse: res => JSONbig.parse(res),
    });
    dispatch({
      type: UPDATE_NON_CLOSING_BP,
      channelId: payment.channelId,
      token: getAddress(payment.token),
      nonClosingBp: body,
    });
    dispatch(saveLuminoData());
  } catch (reqEx) {
    console.error("reqEx Put SecretReveal", reqEx);
  }
};

export const setPaymentSecret = (paymentId, secret) => ({
  type: SET_PAYMENT_SECRET,
  secret,
  paymentId,
});
