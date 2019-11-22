import {
  CREATE_PAYMENT,
  ADD_PENDING_PAYMENT_MESSAGE,
  DELETE_ALL_PENDING_PAYMENTS,
  MESSAGE_POLLING_START,
  MESSAGE_POLLING_STOP,
  SET_PAYMENT_SECRET,
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
} from "../../utils/pack";
import { validateLockedTransfer } from "../../utils/validators";
import { messageManager } from "../../utils/messageManager";
import { getChannelsState } from "../functions";
import { ethers } from "ethers";
import JSONbig from "json-bigint";
import BigNumber from "bignumber.js";
import { MessageType } from "../../config/messagesConstants";
import { saveLuminoData } from "./storage";
import { dispatch } from "rxjs/internal/observable/pairs";

// TODO: Try to store api_key through onboarding

const api_key = "29ad65a6ba88a0c9d732dad37b1dd3c45b9f9130";

/**
 * Create a payment.
 * @param {string} amount- Amount to pay
 * @param {string} address -  The address of the channel creator
 * @param {string} partner -  The partner address
 * @param {string} token_address -  The address of the lumino token
 */
export const createPayment = params => async (dispatch, getState, lh) => {
  try {
    const { address, partner, token_address, amount } = params;
    const hashes = generateHashes();
    const { secrethash, hash: secret } = hashes;
    const requestBody = {
      api_key,
      creator_address: address,
      partner_address: partner,
      amount,
      token_address,
      secrethash,
    };
    const urlCreate = "payments_light/create";
    const res = await client.post(urlCreate, requestBody, {
      headers: {
        "x-api-key": api_key,
      },
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
      receiver: ethers.utils.getAddress(messageWithHash.target),
      sender: ethers.utils.getAddress(messageWithHash.initiator),
      message: {
        ...messageWithHash,
        signature,
      },
    };
    const urlPut = "payments_light";
    await client.put(urlPut, dataToPut, {
      headers: {
        "x-api-key": api_key,
      },
      transformResponse: res => JSONbig.parse(res),
    });
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
        tokenNetworkAddress: dataToPut.message.token_network_address,
        chainId: dataToPut.message.chain_id,
      },
      paymentId: `${dataToPut.message_id}`,
      channelId: dataToPut.message.channel_identifier,
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
// TODO: Try to make sure that the recipient and sender are always correct in reception
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
      headers: {
        "x-api-key": api_key,
      },
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
      headers: {
        "x-api-key": api_key,
      },
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
    sender: getAddress(payment.partner),
    receiver: getAddress(payment.initiator),
    message: {
      type: MessageType.SECRET_REQUEST,
      message_identifier: msg.unsigned_message.message_identifier,
      payment_identifier: payment.paymentId,
      amount: payment.amount,
      expiration: msg.unsigned_message.expiration,
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
      headers: {
        "x-api-key": api_key,
      },
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
      headers: {
        "x-api-key": api_key,
      },
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
      headers: {
        "x-api-key": api_key,
      },
      transformResponse: res => JSONbig.parse(res),
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
