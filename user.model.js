const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const CoordinatesSchema = new Schema({
  Long: {
    type: String,
    required: true
  },
  Lat: {
    type: String,
    required: true
  },
});

const ClusterSchema = new Schema({
  Image: {
    type: String,
    required: true
  },
  Coordinates: {
    type: CoordinatesSchema,
  },
});

const UserSchema = new Schema({
  Username: {
    type: String,
    required: true,
  },
  Clusters: [ClusterSchema],
  CreatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("User", UserSchema);