const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

// --- Configuració de Winston Logger ---
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

// --- Configuració MongoDB ---
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

// --- Configuració WebSocket Server ---
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Guarda l'estat de cada client connectat
const clients = new Map(); // WebSocket -> estat del client

const INACTIVITY_TIMEOUT = 10000; // 10 segons en milisegons

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    logger.info(`Client connectat: ${clientId}`);

    // Inicialitzem l'estat per aquest client
    // *** NOU: Afegim currentPosition controlada pel servidor ***
    clients.set(ws, {
        clientId: clientId,
        currentGameId: null,
        startPosition: null,
        currentPosition: { x: 0, y: 0 }, // Posició inicial controlada pel servidor
        lastPosition: null, // Guardarem l'última posició vàlida de la partida aquí
        lastMoveTime: null,
        inactivityTimer: null,
        gameStartTime: null
    });

    // Enviar la posició inicial al client quan es connecta
    try {
         const initialState = clients.get(ws);
         ws.send(JSON.stringify({ type: 'initialState', x: initialState.currentPosition.x, y: initialState.currentPosition.y }));
     } catch (sendError) {
         logger.error(`[Client ${clientId}] Error enviant estat inicial: ${sendError.message}`);
     }


    // Funció per finalitzar la partida d'un client
    const endGame = (wsClient) => {
        const clientState = clients.get(wsClient);
        if (!clientState || !clientState.currentGameId) {
            return; // Ja s'ha acabat o no ha començat
        }

        clearTimeout(clientState.inactivityTimer);

        // *** CORRECCIÓ: Utilitzem startPosition i lastPosition guardades durant la partida ***
        const { currentGameId, startPosition, lastPosition, gameStartTime, clientId: cId } = clientState;
        let distance = 0;

        // Comprovem que tenim una posició inicial i una última posició vàlida per calcular distància
        if (startPosition && lastPosition) {
            distance = Math.sqrt(
                Math.pow(lastPosition.x - startPosition.x, 2) +
                Math.pow(lastPosition.y - startPosition.y, 2)
            );
            logger.info(`[Game ${currentGameId} - Client ${cId}] Partida finalitzada per inactivitat. Inici: (${startPosition.x},${startPosition.y}), Final: (${lastPosition.x},${lastPosition.y}). Distància: ${distance.toFixed(2)}`);
        } else if (startPosition) {
             // Cas on només hi ha hagut la posició inicial (cap moviment vàlid després)
             logger.info(`[Game ${currentGameId} - Client ${cId}] Partida finalitzada per inactivitat just després d'iniciar. Distància: 0`);
             distance = 0; // La distància és 0 si no hi ha hagut moviment
        }
         else {
            logger.warn(`[Game ${currentGameId} - Client ${cId}] Partida finalitzada sense posició inicial registrada. No es pot calcular distància.`);
            // Pot passar si el client es connecta i es desconnecta o queda inactiu abans de moure's
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
        clientState.lastPosition = null;
        // *** IMPORTANT: Mantenim currentPosition o la resetegem? La resetegem a 0,0 per claredat ***
        clientState.currentPosition = { x: 0, y: 0 };
        clientState.lastMoveTime = null;
        clientState.inactivityTimer = null;
        clientState.gameStartTime = null;

        // Informem al client de la seva nova posició (reset) per si comença nova partida
         try {
             wsClient.send(JSON.stringify({
                 type: 'positionUpdate', // Reutilitzem el tipus
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

            // *** NOU: Esperem una 'command' enlloc de 'x', 'y' ***
            if (typeof data.command !== 'string') {
                throw new Error("Format de missatge invàlid. Falta 'command'.");
            }

            const command = data.command;
            logger.info(`[Client ${cId}] Comanda rebuda: ${command}`);

            const now = Date.now();
            const currentTime = new Date();

            // Si és el primer moviment d'una partida
            if (!clientState.currentGameId) {
                clientState.currentGameId = `G_${now}_${cId.substring(0, 4)}`;
                // *** NOU: La posició inicial és la currentPosition del servidor en aquest moment ***
                clientState.startPosition = { ...clientState.currentPosition }; // Copia l'objecte
                clientState.gameStartTime = currentTime;
                logger.info(`[Game ${clientState.currentGameId} - Client ${cId}] Inici de nova partida a (${clientState.startPosition.x},${clientState.startPosition.y})`);
            }

            // *** NOU: Calcular nova posició basada en la comanda ***
            let newPosition = { ...clientState.currentPosition }; // Copia posició actual
            switch (command) {
                case 'up':
                    newPosition.y -= 1;
                    break;
                case 'down':
                    newPosition.y += 1;
                    break;
                case 'left':
                    newPosition.x -= 1;
                    break;
                case 'right':
                    newPosition.x += 1;
                    break;
                default:
                    logger.warn(`[Client ${cId}] Comanda desconeguda: ${command}`);
                    // Opcional: Enviar error al client
                    try {
                        ws.send(JSON.stringify({ type: 'error', message: `Comanda desconeguda: ${command}` }));
                    } catch (sendError) {
                         logger.error(`[Client ${cId}] Error enviant error de comanda: ${sendError.message}`);
                    }
                    return; // No fer res més si la comanda no és vàlida
            }

            // Actualitzar l'estat del servidor
            clientState.currentPosition = newPosition;
            clientState.lastPosition = { ...newPosition }; // Guardem com a última posició vàlida de la partida
            clientState.lastMoveTime = now;

            // Emmagatzemar a MongoDB (la posició calculada pel servidor)
            const movementData = {
                gameId: clientState.currentGameId,
                clientId: cId,
                command: command, // Guardem la comanda que va causar el moviment
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
                // logger.info(`[Game ${clientState.currentGameId} - Client ${cId}] Moviment (${newPosition.x},${newPosition.y}) per comanda '${command}' emmagatzemat a DB (ID: ${insertResult.insertedId})`);
            } catch (dbErr) {
                logger.error(`[Game ${clientState.currentGameId} - Client ${cId}] Error guardant moviment a MongoDB: ${dbErr}`);
            }

            // *** NOU: Enviar la posició actualitzada al client ***
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


            // Reiniciar el temporitzador d'inactivitat
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
            // Opcional: Finalitzar la partida si es desconnecta? (Podria ser útil)
            // if (clientState.currentGameId) {
            //     endGame(ws);
            // }
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

// Iniciar el servidor només després de connectar a la BD
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
        // Podries tancar aquí la connexió MongoDB si fos necessari
        // MongoClient.close() si has guardat la instància del client.
        process.exit(0);
    });
});