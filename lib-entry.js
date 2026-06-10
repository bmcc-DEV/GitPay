const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const ecc = require('@bitcoinerlab/secp256k1');
const bs58check = require('bs58check');

const bip32 = BIP32Factory(ecc);

/**
 * Derives a Bitcoin address from an extended public key (xpub, ypub, zpub, etc.).
 * 
 * @param {Object} params
 * @param {string} params.extendedKey The extended public key (xpub/ypub/zpub for mainnet, tpub/upub/vpub for testnet)
 * @param {number} params.index The index to derive (change/index path is assumed m/0/index)
 * @param {string} [params.type] Optional. Forced address type: 'p2wpkh' (native SegWit), 'p2sh-p2wpkh' (nested SegWit), 'p2pkh' (legacy)
 * @param {string} [params.networkType] Optional. Forced network type: 'mainnet' or 'testnet'. Defaults to key prefix detection.
 * @returns {Object} Address details including the derived address string and format used.
 */
function deriveAddressFromExtendedKey({ extendedKey, index, type, networkType }) {
  if (!extendedKey || typeof extendedKey !== 'string') {
    throw new Error('Chave estendida inválida ou não fornecida.');
  }

  // Trim key
  extendedKey = extendedKey.trim();

  // 1. Decode and validate extended key
  let decoded;
  try {
    decoded = bs58check.decode(extendedKey);
  } catch (err) {
    throw new Error('Chave estendida inválida (falha no checksum Base58Check). Verifique se digitou corretamente.');
  }

  if (decoded.length !== 78) {
    throw new Error('Tamanho de chave estendida inválido (deve ter 78 bytes decodificados).');
  }

  const versionHex = decoded.slice(0, 4).toString('hex');

  // Prefix definitions
  const mainnetPrefixes = {
    '0488b21e': 'xpub',
    '049d7cb2': 'ypub',
    '04b24746': 'zpub'
  };
  const testnetPrefixes = {
    '043587cf': 'tpub',
    '044a14e2': 'upub',
    '045f1cf6': 'vpub'
  };

  const isTestnetKey = versionHex in testnetPrefixes;
  const isMainnetKey = versionHex in mainnetPrefixes;

  if (!isMainnetKey && !isTestnetKey) {
    throw new Error('Prefixo de chave estendida não suportado (deve começar com xpub, ypub, zpub, tpub, upub, vpub).');
  }

  const keyType = isTestnetKey ? testnetPrefixes[versionHex] : mainnetPrefixes[versionHex];
  
  // Decide which network to use
  let finalNetworkType = networkType;
  if (!finalNetworkType) {
    finalNetworkType = isTestnetKey ? 'testnet' : 'mainnet';
  }

  const network = finalNetworkType === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

  // Convert to standard xpub/tpub prefix if the key is ypub/zpub or upub/vpub
  // This is required because bip32 library only natively parses xpub/tpub magic bytes.
  let standardKey = extendedKey;
  if (keyType !== 'xpub' && keyType !== 'tpub') {
    const targetVersionBytes = isTestnetKey 
      ? Buffer.from('043587cf', 'hex') // tpub
      : Buffer.from('0488b21e', 'hex'); // xpub
    
    const convertedDecoded = Buffer.concat([targetVersionBytes, decoded.slice(4)]);
    standardKey = bs58check.encode(convertedDecoded);
  }

  // 2. Load the node
  const node = bip32.fromBase58(standardKey, network);

  // 3. Derive external chain node: m/0/index (standard for receiving payments)
  const child = node.derive(0).derive(index);

  // 4. Decide address type
  let addressType = type;
  if (!addressType) {
    if (keyType === 'zpub' || keyType === 'vpub') {
      addressType = 'p2wpkh'; // Native SegWit
    } else if (keyType === 'ypub' || keyType === 'upub') {
      addressType = 'p2sh-p2wpkh'; // Nested SegWit
    } else {
      addressType = 'p2pkh'; // Legacy
    }
  }

  // 5. Generate address
  let address = '';
  if (addressType === 'p2wpkh') {
    const payment = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network });
    address = payment.address;
  } else if (addressType === 'p2sh-p2wpkh') {
    const payment = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network }),
      network
    });
    address = payment.address;
  } else {
    const payment = bitcoin.payments.p2pkh({ pubkey: child.publicKey, network });
    address = payment.address;
  }

  return {
    address,
    addressType,
    derivationPath: `m/0/${index}`,
    network: finalNetworkType,
    originalPrefix: keyType
  };
}

module.exports = {
  deriveAddress: deriveAddressFromExtendedKey,
  bitcoinPayments: bitcoin.payments,
  bitcoinNetworks: bitcoin.networks
};
