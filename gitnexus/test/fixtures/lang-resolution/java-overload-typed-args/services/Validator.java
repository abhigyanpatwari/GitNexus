package services;

import models.Request;
import models.Response;

public class Validator {
    public static boolean isValid(Request request) {
        return request.getData() != null;
    }

    public static boolean isValid(Response response) {
        return response.getBody() != null;
    }

    public static boolean checkRequest(Request request) {
        return isValid(request);
    }

    public static boolean checkResponse(Response response) {
        return isValid(response);
    }
}
