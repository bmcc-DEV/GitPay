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

  // Convert first 4 bytes to hex string in a browser-safe way (supports both Buffer and Uint8Array)
  const versionBytes = decoded.slice(0, 4);
  const versionHex = Array.from(versionBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Prefix definitions (including SLIP-0132 multisig capitals Zpub/Ypub/Vpub/Upub)
  const mainnetPrefixes = {
    '0488b21e': 'xpub',
    '049d7cb2': 'ypub',
    '04b24746': 'zpub',
    '02aa7ed3': 'Zpub',
    '0295b43f': 'Ypub'
  };
  const testnetPrefixes = {
    '043587cf': 'tpub',
    '044a14e2': 'upub',
    '045f1cf6': 'vpub',
    '025754f0': 'Vpub',
    '024289ef': 'Upub'
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
      ? new Uint8Array([0x04, 0x35, 0x87, 0xcf]) // tpub
      : new Uint8Array([0x04, 0x88, 0xb2, 0x1e]); // xpub
    
    // Concat using standard Uint8Array to bypass browserify Buffer issues
    const convertedDecoded = new Uint8Array(78);
    convertedDecoded.set(targetVersionBytes, 0);
    convertedDecoded.set(new Uint8Array(decoded.slice(4)), 4);
    
    standardKey = bs58check.encode(convertedDecoded);
  }

  // 2. Load the node
  const node = bip32.fromBase58(standardKey, network);

  // 3. Derive external chain node: m/0/index (standard for receiving payments)
  const child = node.derive(0).derive(index);

  // 4. Decide address type
  let addressType = type;
  if (!addressType) {
    if (keyType === 'zpub' || keyType === 'vpub' || keyType === 'Zpub' || keyType === 'Vpub') {
      addressType = 'p2wpkh'; // Native SegWit
    } else if (keyType === 'ypub' || keyType === 'upub' || keyType === 'Ypub' || keyType === 'Upub') {
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

const crypto = require('crypto');

function generateNostrPrivateKey() {
  let privKey;
  do {
    privKey = crypto.randomBytes(32);
  } while (!ecc.isPrivate(privKey));
  return privKey.toString('hex');
}

function getNostrPublicKey(privateKeyHex) {
  const privKey = Buffer.from(privateKeyHex, 'hex');
  const pubKey = ecc.xOnlyPointFromScalar(privKey);
  return Buffer.from(pubKey).toString('hex');
}

function getEventHash(event) {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  return crypto.createHash('sha256').update(serialized).digest();
}

function signNostrEvent(event, privateKeyHex) {
  const privKey = Buffer.from(privateKeyHex, 'hex');
  if (!event.pubkey) {
    event.pubkey = getNostrPublicKey(privateKeyHex);
  }
  const hash = getEventHash(event);
  const sig = ecc.signSchnorr(hash, privKey);
  event.id = hash.toString('hex');
  event.sig = Buffer.from(sig).toString('hex');
  return event;
}

module.exports = {
  deriveAddress: deriveAddressFromExtendedKey,
  bitcoinPayments: bitcoin.payments,
  bitcoinNetworks: bitcoin.networks,
  generateNostrPrivateKey,
  getNostrPublicKey,
  signNostrEvent
};

