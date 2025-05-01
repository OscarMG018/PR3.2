const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'websocket-game-server' },
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'server.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ],
});

const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
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
        process.exit(1);
    }
}

const PORT = process.env.PORT || 8888;
const wss = new WebSocket.Server({ port: PORT });
const clients = new Map();
const INACTIVITY_TIMEOUT = 10000;

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    logger.info(`Client connectat: ${clientId}`);

    clients.set(ws, {
        clientId: clientId,
        currentGameId: null,
        startPosition: null,
        currentPosition: { x: 0, y: 0 },
        lastPosition: null,
        lastMoveTime: null,
        inactivityTimer: null,
        gameStartTime: null
    });

    try {
         const initialState = clients.get(ws);
         ws.send(JSON.stringify({ type: 'initialState', x: initialState.currentPosition.x, y: initialState.currentPosition.y }));
     } catch (sendError) {
         logger.error(`[Client ${clientId}] Error enviant estat inicial: ${sendError.message}`);
     }

    const endGame = (wsClient) => {
        const clientState = clients.get(wsClient);
        if (!clientState || !clientState.currentGameId) {
            return; 
        }
        clearTimeout(clientState.inactivityTimer);
        const { currentGameId, startPosition, lastPosition, gameStartTime, clientId: cId } = clientState;
        let distance = 0;
        if (startPosition && lastPosition) {
            distance = Math.sqrt(
                Math.pow(lastPosition.x - startPosition.x, 2) +
                Math.pow(lastPosition.y - startPosition.y, 2)
            );
            logger.info(`[Game ${currentGameId} - Client ${cId}] Partida finalitzada per inactivitat. Inici: (${startPosition.x},${startPosition.y}), Final: (${lastPosition.x},${lastPosition.y}). Distància: ${distance.toFixed(2)}`);
        } else if (startPosition) {
             logger.info(`[Game ${currentGameId} - Client ${cId}] Partida finalitzada per inactivitat just després d'iniciar. Distància: 0`);
             distance = 0;
        }
         else {
            logger.warn(`[Game ${currentGameId} - Client ${cId}] Partida finalitzada sense posició inicial registrada. No es pot calcular distància.`);
        }

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

        clientState.currentGameId = null;
        clientState.startPosition = null;
        clientState.lastPosition = null;
        clientState.currentPosition = { x: 0, y: 0 };
        clientState.lastMoveTime = null;
        clientState.inactivityTimer = null;
        clientState.gameStartTime = null;

         try {
             wsClient.send(JSON.stringify({
                 type: 'positionUpdate',
                 x: clientState.currentPosition.x,
                 y: clientState.currentPosition.y
              }));
         } catch(sendError) {
              logger.error(`[Client ${cId}] Error enviant posició reset post-gameover: ${sendError.message}`);
         }

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
            const data = JSON.parse(rawMessage);
            if (typeof data.command !== 'string') {
                throw new Error("Format de missatge invàlid. Falta 'command'.");
            }
            const command = data.command;
            logger.info(`[Client ${cId}] Comanda rebuda: ${command}`);
            const now = Date.now();
            const currentTime = new Date();

            if (!clientState.currentGameId) {
                clientState.currentGameId = `G_${now}_${cId.substring(0, 4)}`;
                clientState.startPosition = { ...clientState.currentPosition };
                clientState.gameStartTime = currentTime;
                logger.info(`[Game ${clientState.currentGameId} - Client ${cId}] Inici de nova partida a (${clientState.startPosition.x},${clientState.startPosition.y})`);
            }
            let newPosition = { ...clientState.currentPosition };
            switch (command) {
                case 'up':
                    newPosition.y += 1;
                    break;
                case 'down':
                    newPosition.y -= 1;
                    break;
                case 'left':
                    newPosition.x -= 1;
                    break;
                case 'right':
                    newPosition.x += 1;
                    break;
                default:
                    logger.warn(`[Client ${cId}] Comanda desconeguda: ${command}`);
                    try {
                        ws.send(JSON.stringify({ type: 'error', message: `Comanda desconeguda: ${command}` }));
                    } catch (sendError) {
                         logger.error(`[Client ${cId}] Error enviant error de comanda: ${sendError.message}`);
                    }
                    return;
            }
            clientState.currentPosition = newPosition;
            clientState.lastPosition = { ...newPosition };
            clientState.lastMoveTime = now;
            const movementData = {
                gameId: clientState.currentGameId,
                clientId: cId,
                command: command,
                x: newPosition.x,
                y: newPosition.y,
                timestamp: currentTime
            };
            try {
                if (!movementsCollection) {
                    logger.error(`[Client ${cId}] Error: La col·lecció MongoDB no està inicialitzada.`);
                    return;
                }
                const insertResult = await movementsCollection.insertOne(movementData);
            } catch (dbErr) {
                logger.error(`[Game ${clientState.currentGameId} - Client ${cId}] Error guardant moviment a MongoDB: ${dbErr}`);
            }
            try {
                ws.send(JSON.stringify({
                    type: 'positionUpdate',
                    x: newPosition.x,
                    y: newPosition.y
                }));
                 logger.info(`[Client ${cId}] Posició actualitzada enviada: (${newPosition.x}, ${newPosition.y})`);
            } catch (sendError) {
                 logger.error(`[Client ${cId}] Error enviant 'positionUpdate': ${sendError.message}`);
            }
            clearTimeout(clientState.inactivityTimer);
            clientState.inactivityTimer = setTimeout(() => {
                logger.warn(`[Client ${cId}] Inactivitat detectada.`);
                endGame(ws);
            }, INACTIVITY_TIMEOUT);

        } catch (error) {
            logger.error(`[Client ${cId}] Error processant missatge: ${error.message}. Missatge original: ${message.toString()}`);
            try {
                ws.send(JSON.stringify({ type: 'error', message: 'Error processant la teva comanda.' }));
            } catch (sendError) {
                 logger.error(`[Client ${cId}] Error enviant missatge d'error general: ${sendError.message}`);
            }
        }
    });

    ws.on('close', () => {
        const clientState = clients.get(ws);
        if (clientState) {
            logger.info(`Client desconnectat: ${clientState.clientId}`);
            if (clientState.inactivityTimer) {
                clearTimeout(clientState.inactivityTimer);
            }
            clients.delete(ws);
        } else {
            logger.warn("Client desconegut s'ha desconnectat.");
        }
    });

    ws.on('error', (error) => {
        const clientState = clients.get(ws);
        const cId = clientState ? clientState.clientId : 'desconegut';
        logger.error(`[Client ${cId}] Error de WebSocket: ${error.message}`);
        if (clientState && clientState.inactivityTimer) {
            clearTimeout(clientState.inactivityTimer);
        }
        if (clientState) {
            clients.delete(ws);
        }
    });
});

async function startServer() {
    await connectDB();
    if (db && movementsCollection) {
        logger.info(`Servidor WebSocket escoltant al port ${PORT}`);
    } else {
        logger.error("No s'ha pogut iniciar el servidor WebSocket per error amb la BD.");
        process.exit(1);
    }
}

startServer();

process.on('SIGINT', () => {
    logger.info("Rebut SIGINT. Tancant servidor...");
    wss.close(() => {
        logger.info("Servidor WebSocket tancat.");
        process.exit(0);
    });
});