import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js"
import { createPlaylistAndAddVideos, addVideosToSelectedPlaylist, removeVideosFromPlaylist, updatePlaylistDetails, getPlaylistById, getAllPlaylists, createEmptyPlaylist, getLoggedInUserPlaylists  } from "../controllers/playlist.controller.js"

const playlistRouter = Router();

playlistRouter.route("/create-empty-playlist").post(verifyJWT, createEmptyPlaylist);

playlistRouter.route("/create-playlist-and-add-videos").post(verifyJWT, createPlaylistAndAddVideos);

playlistRouter.route("/add-videos-to-selected-playlist").post(verifyJWT, addVideosToSelectedPlaylist);

playlistRouter.route("/remove-videos-from-playlist/:playlistId").post(verifyJWT, removeVideosFromPlaylist);

playlistRouter.route("/update-playlist-details/:playlistId").patch(verifyJWT, updatePlaylistDetails);

playlistRouter.route("/get-playlist/:playlistId").get(getPlaylistById);

playlistRouter.route("/get-all-playlists/:userId").get(getAllPlaylists);

playlistRouter.route("/get-logged-in-user-playlists").get(verifyJWT, getLoggedInUserPlaylists);

export default playlistRouter