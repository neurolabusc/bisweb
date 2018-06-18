const $ = require('jquery');
const webutil = require('bis_webutil.js');
const wsutil = require('../../fileserver/wsutil.js');
const jstree = require('jstree');
const BisImage = require('bisweb_image.js');
const zlib = require('zlib');

class FileServer extends HTMLElement {

    constructor() {
        super();
    }

    /**
     * Attaches the algorithm controller to the tree viewer and attaches the event to place the tree viewer's menu in the shared menubar once the main viewer renders.
     */
    connectedCallback() {
        let socket;

        //File tree requests display the contents of the disk on the server machine in a modal
        this.fileTreeDisplayModal = webutil.createmodal('File Tree', 'modal-lg');
        this.fileTreeDisplayModal.dialog.find('.modal-footer').remove();
        this.fileTreeData = null;

        //Save image requests pop up a modal dialog with a text entry field
        this.saveImageModal = null;

        webutil.runAfterAllLoaded(() => {
            let menuBarID = this.getAttribute('bis-menubarid');
            let menuBar = document.querySelector(menuBarID).getMenuBar();

            let algorithmControllerID = this.getAttribute('bis-algorithmcontrollerid');
            this.algorithmcontroller = document.querySelector(algorithmControllerID);

            if (menuBar) {
                let serverMenu = webutil.createTopMenuBarMenu('Server', menuBar);
                webutil.createMenuItem(serverMenu, 'Connect to File Server', () => {
                    socket = this.connectToServer();
                });

                webutil.createMenuItem(serverMenu, 'Request Files', () => {
                    let files = [
                        '/home/zach/MNI_2mm_buggy.nii.gz'
                    ];

                    this.sendFileRequest(socket, {
                        'command' : 'getfile',
                        'files' : files
                    });
                });

                webutil.createMenuItem(serverMenu, 'Show Server Files', () => {
                    this.requestFileList(socket);
                });

                webutil.createMenuItem(serverMenu, 'Upload File to Server', () => {
                    this.createSaveImageDialog(socket);
                });

                webutil.createMenuItem(serverMenu, 'Invoke Module on Server', () => {
                    this.sendInvocationRequest(socket, {
                        'command' : 'runmodule',
                        'params' : {
                            'modulename' : 'smoothImage',
                            'inputs' : [ '/home/zach/MNI_2mm_buggy.nii.gz' ],
                            'args' : {}
                        }
                    });
                });
            }

            socket = this.connectToServer();

            //add the event listeners for the control port
            socket.addEventListener('error', (event) => {
                console.log('An error occured', event);
            });
    
            socket.addEventListener('message', (event) => {
                console.log('received data', event);
                let data;
    
                //parse stringified JSON if the transmission is text
                if (typeof(event.data) === "string") {
                    try {
                        data = JSON.parse(event.data);
                    } catch(e) {
                        console.log('an error occured while parsing event.data', e);
                        return null;
                    }
                } else {
                    console.log('received a binary transmission -- interpreting as an image'); 
                    this.handleImageTransmission(event.data);
                    return;
                }
    
                switch (data.type) {
                    case 'filelist' : this.displayFileList(data.payload); break;
                    case 'supplementalfiles' : this.handleSupplementalFileRequest(data.payload.path, data.payload.list); break;
                    case 'error' : console.log('Error from client:', data.payload); break;
                    case 'datasocketready' : break; //this control phrase is handled elsewhere and should be ignored by this listener.
                    default : console.log('received a transmission with unknown type', data.type, 'cannot interpret');
                } 
            });
        });
    }

    /**
     * Initiates a connection to the fileserver at the specified address. Note that the handshaking protocol is handled entirely by the native Javascript WebSocket API.
     * 
     * @returns A socket representing a successful connection, null otherwise.
     */
    connectToServer(address = 'ws://localhost:8081') {
        let socket = new WebSocket(address);
        return socket;
    }

    /**
     * Sends a request for a list of the files on the server machine and prepares the display modal for the server's reply. 
     * Once the list of files arrives it is rendered using jstree. The user may request individual files from the server using this list. 
     * 
     * requestFileList doesn't expand the contents of the entire server file system; just the first four levels of directories. 
     * When the user clicks on an unexpanded node the node will request four levels of directories below it. 
     * 
     * @param {Socket} socket - A socket representing the connection between client and server (see connectToServer).
     * @param {String} directory - The directory to expand the files under. Optional -- if unspecified the server will return the directories under ~/.
     */
    requestFileList(socket, directory = null) {
        let command = JSON.stringify({ 'command' : 'show', 'directory' : directory }); 
        socket.send(command);

        let loadMessage = $('<div>Loading files from server...</div>')
        this.fileTreeDisplayModal.body.append(loadMessage);
        this.fileTreeDisplayModal.dialog.modal('show');

        //set up file tree events while data is loading
        $(this.fileTreeDisplayModal.body).on('open_node.jstree', (event, data) => {
            data.instance.set_icon(data.node, 'glyphicon glyphicon-folder-open');
            console.log('data', data);
        });

        $(this.fileTreeDisplayModal.body).on('close_node.jstree', (event, data) => {
            data.instance.set_icon(data.node, 'glyphicon glyphicon-folder-close');
        });

        $(this.fileTreeDisplayModal.body).on('select_node.jstree', (event, data) => {
            console.log('data', data);

            //check whether node should expand directories beneath it.
            if (data.node.original.expand) {
                this.requestFileList(socket, data.node.original.path);
            } else if (data.node.type === 'file') {
                this.sendFileRequest(socket, { 'command' : 'getfile', 'files' : [data.node.original.path] });
            }
        });

        $(this.fileTreeDisplayModal.dialog).on('hidden.bs.modal', () => {
            this.fileTreeDisplayModal.body.remove();

            //jstree changes structure of modal-body after it runs, so modal-body needs to be replaced before reloading the file tree
            let newBody = $('<div class="modal-body"></div>');
            this.fileTreeDisplayModal.dialog.find('.modal-content').append(newBody);
            this.fileTreeDisplayModal.body = newBody;
        });

        //nodes open on double click by default, but you can set them to open on single-click
        //https://github.com/vakata/jstree/issues/953
        $(this.fileTreeDisplayModal.body).on('click', '.jstree-anchor', (e) => {
            $(this.fileTreeDisplayModal.body).jstree(true).toggle_node(e.target);
        });
    }

    handleSupplementalFileRequest(path, list) {
        console.log('handleSupplementalFileRequest', path, list);
        let splitPaths = path.split('/'), currentDirectory = this.fileTreeData;
        //first two entries in split paths will be '' 'home' and '[user]' and since the file tree starts below those we can safely remove them.
        console.log('splitPaths', splitPaths);
        splitPaths.splice(0,3);

        //find where to add the supplemental files in this.fileTreeData
        let foundDirectory = false;
        while (splitPaths.length > 0) {
            console.log('looking for a match with', splitPaths[0]);
            for (let entry of currentDirectory) {
                if (entry.text === splitPaths[0]) {

                    //if there's only one entry in splitPaths then this is the index at which we want to add the supplemental files
                    if (splitPaths.length === 1) {
                        entry.children = list;
                        //this.displayFileList(this.fileTreeData);
                        //this.fileTreeDisplayModal.body.jstree(true).refresh();

                        console.log('fileTreeData', this.fileTreeData);
                        return;
                    } else {
                        console.log('entering directory', entry.children);
                        foundDirectory = true;
                        currentDirectory = entry.children;
                    }
                   
                    splitPaths.splice(0,1);
                }
            }

            if (!foundDirectory) {
                console.log('could not find directory.');
                return;
            } else {
                foundDirectory = false;
            }
        }
    }

    /**
     * Renders a file list fetched by requestFileList in the file tree modal using jstree. 
     * Called in response to a file list returned by the server (itself in response to requestFileList) or by the fileTreeDisplayModal trying to fetch more nodes.
     * 
     * @param {Object} list - List of files on the server machine.
     */
    displayFileList(list) {
        console.log('list', list);
        this.fileTreeData = list;
        this.fileTreeDisplayModal.body.jstree({
            'core' : {
                'data' : function(node, cb) { cb(list) },
                'dblclick_toggle' : false,
                'expand_selected_onload' : true
            },
            'types' : {
                'default' : {
                    'icon' : 'glyphicon glyphicon-file'
                },
                'file' : {
                    'icon' : 'glyphicon glyphicon-file'
                },
                'root' : {
                    'icon' : 'glyphicon glyphicon-home'
                },
                'directory' : {
                    'icon' : 'glyphicon glyphicon-folder-close'
                },
                'picture' : {
                    'icon' : 'glyphicon glyphicon-picture'
                },
                'js' : {
                    'icon' : 'glyphicon glyphicon-file'
                },
                'html' : {
                    'icon' : 'glyphicon glyphicon-tasks'
                },
                'video' : {
                    'icon' : 'glyphicon glyphicon-film'
                }, 
                'text' : {
                    'icon' : 'glyphicon glyphicon-list-alt'
                }
            },
            'plugins' : ["types"]
        });
    }

    /**
     * Sends a list of files for the server to upload to the client machine. 
     * 
     * @param {Socket} socket - A socket representing the connection between client and server (see connectToServer).
     * @param {Array} filelist - An array of files to fetch from the server. 
     */
    sendFileRequest(socket, filelist = null) {
        let filesdata = JSON.stringify(filelist);
        socket.send(filesdata);
    }

    sendInvocationRequest(socket, parameters) {
        let params = JSON.stringify(parameters);
        socket.send(params);
    }

    /**
     * Sends a file from the client to the server to be saved on the server machine. Large files are sliced and transmitted in chunks. 
     * Creates its own socket to do the transfer over (doing transfer on control socket seems to make that socket unstable).
     * 
     * TODO: Extend this function to support matrices and transformations.
     * @param {Socket} controlSocket - The socket over which the client and server exchange metadata about the transfer.
     * @param {BisImage} file - The file to save to the server. 
     * @param {String} name - What the filed should be named once it is saved to the server. 
     * @param {Function} cb - A callback for if the transfer is successful. Optional.
     * @param {Function} eb - A callback for if the transfer is a failure (errorback). Optional.
     */
    uploadFileToServer(controlSocket, file, name, cb = () => {}, eb = () => {}) {

        //serialize the BisImage to a purely binary format.
        let serializedImage = file.serializeToNII();
        let packetSize = 50000;
        let fileTransferSocket;

        //negotiate opening of the data port
        controlSocket.addEventListener('message', (e) => {
            let message;
            try {
                message = JSON.parse(e.data);
                if (message.type === 'datasocketready') {

                    fileTransferSocket = this.connectToServer('ws://localhost:8082');
                    fileTransferSocket.addEventListener('open', () => {
                        console.log('serializedImage', serializedImage);
                        doImageTransfer(serializedImage);
                    });

                } else {
                    console.log('heard unexpected message', message, 'not opening data socket');
                    eb();
                }
            } catch(e) {
                console.log('failed to parse response to data socket request from server', e);
                eb();
            }
        }, { once : true });


        controlSocket.send(JSON.stringify({
            'command': 'uploadimage',
            'totalSize': serializedImage.length,
            'packetSize': packetSize,
            'storageSize': file.internal.imgdata.BYTES_PER_ELEMENT,
            'header': file.header,
            'filename': name
        }));


        //transfer image in 50KB chunks, wait for acknowledge from server
        function doImageTransfer(image) {
            let remainingTransfer = image, currentTransferIndex = 0;
           
            //send data in chunks
            let sendDataSlice = () => {
                let slice = (currentTransferIndex + packetSize >= remainingTransfer.size) ?
                    remainingTransfer.slice(currentTransferIndex) :
                    remainingTransfer.slice(currentTransferIndex, currentTransferIndex + packetSize);
                fileTransferSocket.send(slice);
                currentTransferIndex = currentTransferIndex + slice.length;
            }

            fileTransferSocket.addEventListener('message', (event) => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (e) {
                    console.log('an error occured while parsing event.data', e);
                    eb();
                    return null;
                }

                switch (data.type) {
                    case 'nextpacket':
                        sendDataSlice();
                        break;
                    case 'uploadcomplete':
                        fileTransferSocket.close();
                        cb();
                        break;
                    default: console.log('received unexpected message', event, 'while listening for server responses');
                }
            });

            sendDataSlice();
        }
    }

    /**
     * Takes raw input from the server, formats it as a proper BisImage and displays it. 
     * Note that the server transfers images in binary form to avoid wasting space converting it to UTF-8 or a similar encoding. 
     *  
     * @param {Uint8Array} data - Image transferred by the server. 
     */
    handleImageTransmission(data) {

        let reader = new FileReader();

        //image is sent compressed for portability reasons, then decompressed here
        reader.addEventListener('loadend', () => {
            let unzippedFile = wsutil.unzipFile(reader.result);

            let loadedImg = new BisImage();
            loadedImg.initialize();
            loadedImg.parseNII(unzippedFile.buffer, true);

            this.algorithmcontroller.sendImageToViewer(loadedImg, { viewername: this.defaultViewer });
        });

        reader.readAsArrayBuffer(data);
    }

    createSaveImageDialog(socket) {
        let saveDialog = $(`<p>Please enter a name for the current image on the viewer. Do not include a file extension.</p>`);
        let nameEntryBox = $(`
                <div class='form-group'>
                    <label for='filename'>Filename:</label>
                    <input type='text' class = 'form-control'>
                </div>
            `);

        if (!this.saveImageModal) {
            this.saveImageModal = webutil.createmodal('Save Current Image?', 'modal-sm');
            this.saveImageModal.dialog.find('.modal-footer').find('.btn').remove();

            let confirmButton = webutil.createbutton({ 'name': 'Confirm', 'type': 'btn-success' });
            let cancelButton = webutil.createbutton({ 'name': 'Cancel', 'type': 'btn-danger' });

            this.saveImageModal.footer.append(confirmButton);
            this.saveImageModal.footer.append(cancelButton);

            $(confirmButton).on('click', () => {
                let image = this.algorithmcontroller.getImage('viewer', 'image');
                let name = this.saveImageModal.body.find('.form-control')[0].value;


                 //update the modal with a success message after successful transmission.
                 let cb = () => {
                     let transmissionCompleteMessage = $(`<p>Upload completed successfully.</p>`);

                     this.saveImageModal.body.empty();
                     this.saveImageModal.body.append(transmissionCompleteMessage);

                     setTimeout(() => { this.saveImageModal.dialog.modal('hide'); }, 1500);
                };

                //update modal with an error message if things went wrong
                let eb = () => {
                    let errorMessage = $(`<p>An error occured during transmission. File not uploaded.</p>`)

                    this.saveImageModal.body.empty();
                    this.saveImageModal.body.append(transmissionCompleteMessage);

                    setTimeout(() => { this.saveImageModal.dialog.modal('hide'); }, 1500);
                }

                this.uploadFileToServer(socket, image, name, cb, eb);

                let imageSavingDialog = $(`<p>Uploading image to file server...</p>`);
                this.saveImageModal.body.empty();
                this.saveImageModal.body.append(imageSavingDialog);

               

            });

            $(cancelButton).on('click', () => {
                this.saveImageModal.dialog.modal('hide');
            });

            //clear name entry input when modal is closed
            $(this.saveImageModal.dialog).on('hidden.bs.modal', () => {
                this.saveImageModal.body.empty();
            });
        }

        this.saveImageModal.body.append(saveDialog);
        this.saveImageModal.body.append(nameEntryBox);

        this.saveImageModal.dialog.modal('show');
    }
}

webutil.defineElement('bisweb-fileserver', FileServer);
