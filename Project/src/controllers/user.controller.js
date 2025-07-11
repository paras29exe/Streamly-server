import { asyncHandler } from "../utils/asyncHandler.js"
import { ApiError } from "../utils/apiError.js"
import { User } from "../models/user.model.js"
import { Video, Like, Comment, Subscription, Playlist } from "../models/index.js"
import { fileUploadOnCloudinary, deleteFileFromCloudinary } from "../utils/cloudinary.js"
import { ApiResponse } from "../utils/apiResponse.js"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import fs from "fs"
import { OAuth2Client } from "google-auth-library"
import isLoggedIn from "../utils/isLoggedIn.js"
import axios from "axios"

const options = {
    httpOnly: true,
    secure: true,
    sameSite: 'none'
}

const generateAccessAndRefreshToken = async (userId) => {
    // try catch 
    try {
        const user = await User.findById(userId)
        const accessToken = user.generateAccessToken()
        const refreshToken = user.generateRefreshToken()

        // save refresh token in db so that we dont have to ask for password everytime
        user.refreshToken = refreshToken
        await user.save({ validateBeforeSave: false })

        return { accessToken, refreshToken }

    } catch (error) {
        throw new ApiError("Something went wrong when generating access and refresh tokens", error)
    }
}

const registerUser = asyncHandler(async (req, res, next) => {

    const avatarLocalPath = req.files?.avatar?.[0]?.path
    const coverImageLocalPath = req.files.coverImage?.[0]?.path

    const { fullName, username, password } = req.body
    const email = req.body.email?.trim().toLowerCase();
    try {

        if (!fullName || !email || !username || !password) throw new ApiError(404, "All fields are required")

        // Check if email or username already exists in the database
        const existedEmail = await User.findOne({ email: email })

        if (existedEmail) {
            throw new ApiError(409, "Email already registered", "email")
        }

        const existedUsername = await User.findOne({ username: username.toLowerCase() })

        if (existedUsername) {
            throw new ApiError(409, "Username not available", "username")
        }

        // logics for avatar and cover image

        if (!avatarLocalPath) throw new ApiError(400, "Avatar is required field", "avatar")

        if (!coverImageLocalPath) console.log("coverImageLocalPath : Alert! You didn't provided a coverImage")

        let avatar = await fileUploadOnCloudinary(avatarLocalPath)
        avatar.url = avatar.url.replace('http://', 'https://') // Ensure the avatar URL is secure

        // as coverImage is not required necessary so we are handling it if it is given
        let coverImage;
        if (coverImageLocalPath) {
            coverImage = await fileUploadOnCloudinary(coverImageLocalPath)
            coverImage.url = coverImage.url.replace('http://', 'https://') // Ensure the cover image URL is secure
        }

        /* it will create a new document in "users" named collection and if collection doesn't exists,
          it will create a collection first with the name of model created in user.model.js */

        const user = await User.create({
            fullName,
            email,
            username: username.toLowerCase(),
            password: String(password),
            avatar: avatar.url,
            coverImage: coverImage.url || ""
        })

        const createdUser = await User.findById(user._id)

        if (!createdUser) {
            throw new ApiError(500, "Something went wrong while creating user")
        }

        loginUser({ body: { username, password: String(password) } }, res, next)
    } catch (error) {
        avatarLocalPath && fs.unlink(avatarLocalPath, () => { })
        coverImageLocalPath && fs.unlink(coverImageLocalPath, () => { })
        throw error;
    }
})

const loginUser = asyncHandler(async (req, res, next) => {
    // take data from req.body
    // take username or email to login
    // find user from db
    // validate password
    // send access token and refresh token
    // send cookies

    const { username, password } = req.body

    if (!username) {
        throw new ApiError(400, "Username or email is required", "username")
    }

    const user = await User.findOne({
        // "$or" return true if any one or more item is found
        $or: [{ username: username }, { email: username }]
    })

    if (!user) {
        throw new ApiError(401, "Username or Email not found", "username")
    }

    if (user.googleLogin) {
        throw new ApiError(401, "Email or username is registered with Google. Please login with Google", "username")
    }

    const isPassValid = await user.isPasswordCorrect(String(password))

    if (!isPassValid) {
        throw new ApiError(401, "Invalid Password", "password")
    }

    const { accessToken, refreshToken } = await generateAccessAndRefreshToken(user._id)

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken -watchHistory")

    // we need options when we send cookies to the server so that they can be modified only by server not by user
   
    return res.status(200)
        .cookie("accessToken", accessToken, { ...options, maxAge: parseInt(process.env.ACCESS_TOKEN_EXPIRY) * 24 * 60 * 60 * 1000 })
        .cookie("refreshToken", refreshToken, { ...options, maxAge: parseInt(process.env.REFRESH_TOKEN_EXPIRY) * 24 * 60 * 60 * 1000 })
        .json(new ApiResponse(200, loggedInUser, "User logged in successfully"))
})

const loginWithGoogle = asyncHandler(async (req, res, next) => {
    // const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
    const { token } = req.body

    try {
        const response = await axios.get("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${token}` },
        });

        const { email, sub, name, picture } = response.data

        // const picture = `https://ui-avatars.com/api/?name=${name}&length=1&background=0D8ABC&color=ffffff&bold=true`

        let user = await User.findOne({ email }).select("-password -watchHistory -refreshToken")

        if (!user) {
            user = await User.create({
                fullName: name,
                email: email,
                username: email.split("@")[0],
                password: String(sub),
                avatar: picture,
                googleLogin: true
            })
        }

        const loggedInUser = await User.findById(user._id).select("-password -refreshToken -watchHistory")

        const { accessToken, refreshToken } = await generateAccessAndRefreshToken(user._id)


        return res.status(200)
            .cookie("accessToken", accessToken, { ...options, maxAge: parseInt(process.env.ACCESS_TOKEN_EXPIRY) * 24 * 60 * 60 * 1000 })
            .cookie("refreshToken", refreshToken, { ...options, maxAge: parseInt(process.env.REFRESH_TOKEN_EXPIRY) * 24 * 60 * 60 * 1000 })
            .json(new ApiResponse(200, loggedInUser, "User logged in successfully"))

    } catch (error) {
        console.log(error);

        throw new ApiError(500, "Failed to login with Google", error)
    }
})

const logoutUser = asyncHandler(async (req, res) => {
    // we got the user details from the middleware from auth.middleware.js
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $unset: {
                refreshToken: 1 // this removes the field from document
            }
        }
    )

    return res.status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(new ApiResponse(200, {}, "User has been logged out"))
})

const refreshTheTokens = asyncHandler(async (req, res, next) => {
    // get the refresh token from cookies

    const { accessToken, refreshToken } = await generateAccessAndRefreshToken(req.user._id)

    return res.status(200)
        .cookie("accessToken", accessToken, { ...options, maxAge: parseInt(process.env.ACCESS_TOKEN_EXPIRY) * 24 * 60 * 60 * 1000 })
        .cookie("refreshToken", refreshToken, { ...options, maxAge: parseInt(process.env.REFRESH_TOKEN_EXPIRY) * 24 * 60 * 60 * 1000 })
        .json(new ApiResponse(200, req.user, "Access token refreshed successfully"))
})

const changeCurrentPassword = asyncHandler(async (req, res) => {
    // get the user details from the middleware from auth.middleware.js
    // get the old password from req.body
    // validate old password
    // update the password in db
    // return success message

    const { currentPassword, newPassword } = req.body

    if (currentPassword && newPassword) {

        const user = await User.findById(req.user?._id)
        const isPassValid = await user.isPasswordCorrect(currentPassword)

        if (!isPassValid) {
            throw new ApiError(401, "Current Password is incorrect!")
        }

        user.password = newPassword;
        await user.save({ validateBeforeSave: false })

        return res.status(200)
            .json(new ApiResponse(200, {}, "Password changed successfully"))

    } else {

        return res.status(400)
            .json(new ApiResponse(400, {}, "All fields are required!"))
    }

})

const getCurrentUser = asyncHandler(async (req, res) => {
    return res.status(200)
        .json(new ApiResponse(200, req.user, "User has been fetched"))
})

const updateAccountDetails = asyncHandler(async (req, res) => {
    // take fields to be changed
    // update them in database 
    // return the response
    const { fullName, username, sameCover } = req.body

    const { avatar, coverImage } = req.files || {}

    try {
        if (!fullName && !username && !avatar && !coverImage && sameCover === 'true') {
            return res.status(400)
                .json(new ApiError(400, {}, "No Changes have been made by user"))
        }

        if (username) {
            const userExists = await User.findOne({ username })
            if (userExists && userExists._id.toString() !== req.user._id.toString()) {
                throw new ApiError(409, "Username already taken", "username")
            }
        }

        // storing the changed field to return in response by selecting the changed field
        let avatarLink;
        let coverImageLink;

        if (avatar) {

            const avatarLocalPath = avatar[0]?.path

            avatarLink = await fileUploadOnCloudinary(avatarLocalPath)
            avatarLink = avatarLink.url.replace('http://', 'https://') // Ensure the avatar URL is secure

            if (!avatarLink) {
                throw new ApiError(500, "Failed to upload avatar on Cloudinary")
            }

            if (req.user?.avatar) {
                await deleteFileFromCloudinary(req.user.avatar)
            }
        }

        if (sameCover === 'false' && !coverImage) {
            if (req.user?.coverImage) {
                await deleteFileFromCloudinary(req.user.coverImage)
                req.user.coverImage = ""
            }
        }

        if (coverImage) {
            const coverImageLocalPath = coverImage[0]?.path

            coverImageLink = await fileUploadOnCloudinary(coverImageLocalPath)
            coverImageLink = coverImageLink.url.replace('http://', 'https://') // Ensure the cover image URL is secure

            if (!coverImageLink) {
                throw new ApiError(500, "Failed to upload cover image on Cloudinary")
            }

            if (req.user?.coverImage) {
                await deleteFileFromCloudinary(req.user.coverImage)
            }
        }

        const userAccount = await User.findByIdAndUpdate(req.user._id,
            {
                $set: {
                    fullName: fullName || req.user.fullName,
                    username: username || req.user.username,
                    avatar: avatarLink || req.user.avatar,
                    coverImage: coverImageLink || req.user.coverImage
                }
            },
            { new: true }
        ).select(`username fullName email avatar coverImage`)

        await Video.updateMany({ ownerId: req.user?.id }, {
            $set: {
                ownerChannelName: fullName || req.user.fullName,
                ownerUsername: username || req.user.username,
                ownerAvatar: avatarLink || req.user.avatar,
            }
        })
        await Comment.updateMany({ ownerId: req.user?.id }, {
            $set: {
                ownerUsername: username || req.user.username,
                ownerAvatar: avatarLink || req.user.avatar,
            }
        })

        return res.status(200)
            .json(new ApiResponse(200, userAccount, "Account details updated successfully!"))

    } catch (error) {
        avatar && fs.unlink(avatar[0]?.path, () => { })
        coverImage && fs.unlink(coverImage[0]?.path, () => { })
        throw error
    }
})

const getChannelById = asyncHandler(async (req, res) => {
    req.user = await isLoggedIn(req)

    const { page = 1, limit = 24 } = req.query
    const { username } = req.params
    // console.log(username);
    // if (!mongoose.isValidObjectId(username)) throw new ApiError(400, "Invalid Channel ID provided")

    try {
        const channel = await User.aggregate([
            {
                $facet: {
                    channelDetails: [
                        {
                            $match: {
                                username: username,
                                _id: { $ne: req?.user?._id }
                            }
                        },
                        { $addFields: { channelName: "$fullName" } },
                        // finding no. of documents in subscription collection that has his ID in "channel" field
                        {
                            $lookup: {
                                from: "subscriptions",
                                localField: "_id",
                                foreignField: "channel",
                                as: "subscribers"
                            }
                        },
                        {
                            // overwriting the matching documents with in array their size of array or count of documents 
                            $addFields: {
                                subscribers: { $size: "$subscribers" }
                            }
                        },
                        {
                            $lookup: {
                                from: "subscriptions",
                                let: {
                                    channel: "$_id",
                                    viewer: req.user?._id
                                },
                                pipeline: [
                                    {
                                        $match: {
                                            $expr: {
                                                $and: [
                                                    { $eq: ["$channel", "$$channel"] },
                                                    { $eq: ["$subscriber", "$$viewer"] }
                                                ]
                                            }
                                        }
                                    }
                                ],
                                as: "subscribedByViewer"
                            }
                        },
                        {
                            $addFields: {
                                subscribedByViewer: {
                                    $cond: [
                                        { $eq: [{ $size: "$subscribedByViewer" }, 1] },
                                        true,
                                        false
                                    ]
                                }
                            }
                        },
                        {
                            $lookup: {
                                from: "videos",
                                localField: "_id",
                                foreignField: "ownerId",
                                as: "totalVideos"
                            }
                        },
                        {
                            $addFields: {
                                totalVideos: { $size: "$totalVideos" }
                            }
                        },
                        {
                            $project: {
                                fullName: 0,
                                email: 0,
                                password: 0,
                                __v: 0,
                                refreshToken: 0,
                                accessToken: 0,
                                watchHistory: 0,
                                updatedAt: 0
                            }
                        }

                    ],
                    popularVideos: [
                        {
                            $match: { username: username },
                        },
                        {
                            $lookup: {
                                from: "videos",
                                localField: "_id",
                                foreignField: "ownerId",
                                as: "popularVideos",
                                pipeline: [
                                    {
                                        $match: {
                                            publishStatus: "public",
                                        }
                                    },
                                    {
                                        $sort: { "views": -1 }
                                    },
                                    {
                                        $limit: 5
                                    },
                                    {
                                        $project: {
                                            description: 0,
                                            videoFile: 0,
                                            publishStatus: 0,
                                            updatedAt: 0,
                                            __v: 0,
                                            ownerUsername: 0,
                                        }
                                    },
                                ]
                            }
                        },
                        { $unwind: "$popularVideos" },
                        { $replaceRoot: { newRoot: "$popularVideos" } },
                    ],
                    recentVideos: [
                        {
                            $match: { username: username },
                        },
                        {
                            $lookup: {
                                from: "videos",
                                localField: "_id",
                                foreignField: "ownerId",
                                as: "recentVideos",
                                pipeline: [
                                    {
                                        $match: {
                                            publishStatus: "public",
                                        }
                                    },
                                    {
                                        $sort: { createdAt: -1 }
                                    },
                                    {
                                        $limit: 5
                                    },
                                    {
                                        $project: {
                                            description: 0,
                                            videoFile: 0,
                                            publishStatus: 0,
                                            updatedAt: 0,
                                            __v: 0,
                                            ownerUsername: 0,
                                        }
                                    },
                                ]
                            }
                        },
                        { $unwind: "$recentVideos" },
                        { $replaceRoot: { newRoot: "$recentVideos" } },
                    ]
                },
            },
            {
                $unwind: "$channelDetails"
            },
        ])

        if (!channel[0]) {
            throw new ApiError(404, "Channel not found", "wrong username")
        }

        return res.status(200)
            .json(new ApiResponse(200, channel[0], "Channel fetched successfully"));
    } catch (error) {
        throw error
    }
})

const getWatchHistory = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const watchHistory = await User.aggregate([
        {
            $match: { _id: userId }
        },
        {
            $project: {
                watchHistory: 1 // Preserve the original order
            }
        },
        {
            $lookup: {
                from: "videos",
                localField: "watchHistory",
                foreignField: "_id",
                as: "videoDetails"
            }
        },
        {
            $addFields: {
                watchHistory: {
                    $map: {
                        input: "$watchHistory",
                        as: "videoId",
                        in: {
                            $arrayElemAt: [
                                {
                                    $filter: {
                                        input: "$videoDetails",
                                        as: "video",
                                        cond: { $eq: ["$$video._id", "$$videoId"] }
                                    }
                                },
                                0
                            ]
                        }
                    }
                }
            }
        },
        {
            $addFields: {
                watchHistory: {
                    $filter: {
                        input: "$watchHistory",
                        as: "video",
                        cond: { $ne: ["$$video", null] } // Remove null entries
                    }
                }
            }
        },
        {
            $unwind: "$watchHistory"
        },
        {
            $replaceRoot: { newRoot: "$watchHistory" }
        }
    ]);

    return res.status(200)
        .json(new ApiResponse(200, watchHistory, "Watch history fetched successfully."));
})

// remove video from watch history
const removeVideoFromWatchHistory = asyncHandler(async (req, res) => {
    const { videoId } = req.params;
    const userId = req.user._id;

    await User.findByIdAndUpdate(userId, {
        $pull: { watchHistory: videoId }
    });

    return res.status(200)
        .json(new ApiResponse(200, {}, "Video removed from watch history successfully."));
})

const deleteAccount = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const session = await mongoose.startSession();

    session.startTransaction();

    try {
        await User.findByIdAndDelete(userId).session(session);

        // deleting user's channel avatar and cover
        await deleteFileFromCloudinary(req.user.avatar);
        (req.user.coverImage !== "") ? await deleteFileFromCloudinary(req.user.coverImage) : null;

        // finding all videos of user
        const videos = await Video.find({ ownerId: userId });

        if (videos.length > 0) {

            for (const video of videos) {
                // deleting files of each video
                await deleteFileFromCloudinary(video.thumbnail)
                await deleteFileFromCloudinary(video.videoFile)

                // deleting likes on each video of user
                await Like.deleteMany({ video: video._id })

                // finding comments of each video
                const comments = await Comment.find({ videoId: video._id });

                if (comments.length > 0) {
                    for (const comment of comments) {
                        // deleting likes on comments of each video of user
                        await Like.deleteMany({ comment: comment._id }).session(session)
                    }
                }

                // in last deleting all the comments on user videos 
                await Comment.deleteMany({ videoId: video._id }).session(session);
            }
        }

        await Video.deleteMany({ ownerId: userId }).session(session);
        await Like.deleteMany({ likedBy: userId }).session(session);
        await Comment.deleteMany({ ownerId: userId }).session(session);
        await Playlist.deleteMany({ ownerId: userId }).session(session);
        await Subscription.deleteMany({
            $or: [
                { subscriber: userId },
                { channel: userId }
            ]
        }).session(session);

        await session.commitTransaction();
        session.endSession();

        res.clearCookie('accessToken');
        res.clearCookie('refreshToken');

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        throw new ApiError(500, "Failed to delete user and its related data", error);
    }

    return res.status(200)
        .json(new ApiResponse(200, {}, "User and its all related data has been deleted"));
});

export {
    registerUser,
    loginUser,
    loginWithGoogle,
    logoutUser,
    refreshTheTokens,
    changeCurrentPassword,
    getCurrentUser,
    updateAccountDetails,
    getChannelById,
    getWatchHistory,
    removeVideoFromWatchHistory,
    deleteAccount,
}