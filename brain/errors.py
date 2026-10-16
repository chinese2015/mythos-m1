class BrainError(Exception):
    status = 400
    code = 'INVALID_INPUT'


class InvalidInput(BrainError):
    pass


class NotFound(BrainError):
    status = 404
    code = 'NOT_FOUND'


class Conflict(BrainError):
    status = 409
    code = 'CONFLICT'


class Unauthorized(BrainError):
    status = 401
    code = 'UNAUTHORIZED'


class PreparationFailure(RuntimeError):
    def __init__(self, message, runtime):
        super().__init__(message)
        self.runtime = dict(runtime, preparedOnly=True)
