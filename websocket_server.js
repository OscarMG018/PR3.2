const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid'); // Per IDs de partida més únics (opcional, sinó usem timestamp) npm install uuid

// --- Configuració de Winston Logger ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json() // Format JSON per facilitar el parseig si cal
    ),
    defaultMeta: { service: 'websocket-game-server' },
    transports: [
        // Escriu tots els logs amb nivell 'error' o menys al fitxer `error.log`
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        // Escriu tots els logs amb nivell 'info' o menys al fitxer `server.log`
        new winston.transports.File({ filename: 'server.log' }),
        // Mostra logs per consola amb un format més llegible
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ],
});

// --- Configuració MongoDB ---
const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017'; // Permet configurar via variable d'entorn
const dbName = 'gameData';
const collectionName = 'movements';
let db;
let movementsCollection;

async function connectDB() {
    try {
        const client = new MongoClient(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true });
        await client.connect();
        db = client.db(dbName);
        movementsCollection = db.collection(collectionName);
        logger.info(`Connectat correctament a MongoDB: ${mongoUrl} - Base de dades: ${dbName}`);
    } catch (err) {
        logger.error('Error connectant a MongoDB:', err);
        process.exit(1); // Sortir si no es pot connectar a la BD
    }
}

// --- Configuració WebSocket Server ---
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Guarda l'estat de cada client connectat
const clients = new Map(); // Utilitzem un Map per associar WebSocket -> estat del client

const INACTIVITY_TIMEOUT = 10000; // 10 segons en milisegons

wss.on('connection', (ws) => {
    const clientId = uuidv4(); // Assignem un ID únic al client per logging
    logger.info(`Client connectat: ${clientId}`);

    // Inicialitzem l'estat per aquest client
    clients.set(ws, {
        clientId: clientId,
        currentGameId: null,
        startPosition: null,
        lastPosition: null,
        lastMoveTime: null,
        inactivityTimer: null,
        gameStartTime: null
    });

    // Funció per finalitzar la partida d'un client
    const endGame = (wsClient) => {
        const clientState = clients.get(wsClient);
        if (!clientState || !clientState.currentGameId) {
            // logger.warn(`Intempt d'acabar partida inexistent o ja acabada per client ${clientState?.clientId}`);
            return; // Ja s'ha acabat o no ha començat
        }

        clearTimeout(clientState.inactivityTimer); // Netegem el timer per si de cas

        const { currentGameId, startPosition, lastPosition, gameStartTime, clientId: cId } = clientState;
        let distance = 0;

        if (startPosition && lastPosition) {
            distance = Math.sqrt(
                Math.pow(lastPosition.x - startPosition.x, 2) +
                Math.pow(lastPosition.y - startPosition.y, 2)
            );
            logger.info(`[Game ${currentGameId} - Client ${cId}] Partida finalitzada per inactivitat. Inici: (${startPosition.x},${startPosition.y}), Final: (${lastPosition.x},${lastPosition.y}). Distància: ${distance.toFixed(2)}`);
        } else {
             logger.warn(`[Game ${currentGameId} - Client ${cId}] Partida finalitzada per inactivitat, però falta posició inicial o final. Distància: 0`);
        }

        // Enviem resultat al client
        try {
            wsClient.send(JSON.stringify({
                type: 'gameOver',
                gameId: currentGameId,
                distance: distance.toFixed(2),
                startTime: gameStartTime,
                endTime: new Date()
            }));
        } catch (sendError) {
             logger.error(`[Client ${cId}] Error enviant missatge 'gameOver': ${sendError.message}`);
        }


        // Resetejem l'estat de la partida per aquest client
        clientState.currentGameId = null;
        clientState.startPosition = null;
        clientState.lastPosition = null; // Important resetejar per la propera partida
        clientState.lastMoveTime = null;
        clientState.inactivityTimer = null;
        clientState.gameStartTime = null;
    };

    ws.on('message', async (message) => {
        const clientState = clients.get(ws);
        if (!clientState) {
            logger.error("Rebut missatge d'un client desconegut.");
            return;
        }
        const { clientId: cId } = clientState;

        try {
            const rawMessage = message.toString();
            //logger.info(`[Client ${cId}] Missatge rebut: ${rawMessage}`); // Log raw si cal depurar
            const data = JSON.parse(rawMessage);

            // Validació bàsica
            if (typeof data.x !== 'number' || typeof data.y !== 'number') {
                throw new Error("Format de missatge invàlid. Falten 'x' o 'y'.");
            }

            //logger.info(`[Client ${cId}] Dades rebudes: x=${data.x}, y=${data.y}`);

            const now = Date.now();
            const currentTime = new Date();

            // Si és el primer moviment d'una partida (o el primer després d'un timeout)
            if (!clientState.currentGameId) {
                clientState.currentGameId = `G_${now}_${cId.substring(0,4)}`; // Generem ID de partida
                clientState.startPosition = { x: data.x, y: data.y };
                clientState.gameStartTime = currentTime;
                logger.info(`[Game ${clientState.currentGameId} - Client ${cId}] Inici de nova partida a (${data.x},${data.y})`);
            }

            // Actualitzem l'última posició i temps
            clientState.lastPosition = { x: data.x, y: data.y };
            clientState.lastMoveTime = now;

            // Emmagatzemar a MongoDB
            const movementData = {
                gameId: clientState.currentGameId,
                clientId: cId,
                x: data.x,
                y: data.y,
                timestamp: currentTime
            };

            try {
                 if (!movementsCollection) {
                     logger.error(`[Client ${cId}] Error: La col·lecció MongoDB no està inicialitzada.`);
                     // Podriem intentar reconnectar o enviar un error al client
                     return;
                 }
                const insertResult = await movementsCollection.insertOne(movementData);
                //logger.info(`[Game ${clientState.currentGameId} - Client ${cId}] Moviment (${data.x},${data.y}) emmagatzemat a DB (ID: ${insertResult.insertedId})`);
            } catch (dbErr) {
                logger.error(`[Game ${clientState.currentGameId} - Client ${cId}] Error guardant moviment a MongoDB: ${dbErr}`);
                // Considerar què fer aquí: informar el client? reintentar?
            }

            // Reiniciar el temporitzador d'inactivitat
            clearTimeout(clientState.inactivityTimer); // Neteja el timer anterior si existeix
            clientState.inactivityTimer = setTimeout(() => {
                logger.warn(`[Client ${cId}] Inactivitat detectada.`);
                endGame(ws); // Crida a la funció que finalitza la partida
            }, INACTIVITY_TIMEOUT);

        } catch (error) {
            logger.error(`[Client ${cId}] Error processant missatge: ${error.message}. Missatge original: ${message.toString()}`);
            // Podries enviar un missatge d'error al client si el format és incorrecte
             try {
                 ws.send(JSON.stringify({ type: 'error', message: 'Format de missatge invàlid.' }));
             } catch (sendError) {
                  logger.error(`[Client ${cId}] Error enviant missatge d'error al client: ${sendError.message}`);
             }
        }
    });

    ws.on('close', () => {
        const clientState = clients.get(ws);
        if (clientState) {
            logger.info(`Client desconnectat: ${clientState.clientId}`);
            // Si hi havia un timer d'inactivitat actiu, netejar-lo
            if (clientState.inactivityTimer) {
                clearTimeout(clientState.inactivityTimer);
            }
            // Opcional: Podríem considerar la partida com a 'abandonada' o finalitzar-la aquí també
            // endGame(ws); // Descomentar si volem que la desconnexió forci el final de partida
            clients.delete(ws); // Eliminar el client del Map
        } else {
             logger.warn("Client desconegut s'ha desconnectat.");
        }
    });

    ws.on('error', (error) => {
         const clientState = clients.get(ws);
         const cId = clientState ? clientState.clientId : 'desconegut';
         logger.error(`[Client ${cId}] Error de WebSocket: ${error.message}`);
         // Neteja si hi ha error
         if (clientState && clientState.inactivityTimer) {
             clearTimeout(clientState.inactivityTimer);
         }
         if (clientState) {
             clients.delete(ws);
         }
    });
});

// Iniciar el servidor només després de connectar a la BD
async function startServer() {
    await connectDB(); // Espera que la connexió a la BD estigui llesta
    if (db && movementsCollection) { // Comprova si la connexió ha estat exitosa
        logger.info(`Servidor WebSocket escoltant al port ${PORT}`);
    } else {
        logger.error("No s'ha pogut iniciar el servidor WebSocket per error amb la BD.");
        process.exit(1);
    }
}

startServer();

// Gestió de tancament net
process.on('SIGINT', () => {
    logger.info("Rebut SIGINT. Tancant servidor...");
    wss.close(() => {
        logger.info("Servidor WebSocket tancat.");
        // Aquí podries tancar la connexió MongoDB si fos necessari (el driver sol gestionar-ho)
        process.exit(0);
    });
});