use crate::{
    domain::context::RequestContext,
    http::{
        dto::{
            FieldSchemaUpdateRequest, FieldSchemaUpdateResponse, HorizontalListRequest,
            HorizontalListResponse, InitRequest, InitResponse, MetadataQueryRequest,
            MetadataQueryResponse, PageRequest, PageResponse,
        },
        envelope::Envelope,
        error::ApiError,
    },
    ports::field_catalog::FieldCatalogEntry,
};

pub trait MetadataQueryUseCase: Send + Sync {
    fn query_metadata(
        &self,
        context: &RequestContext,
        request: MetadataQueryRequest,
    ) -> Result<MetadataQueryResponse, ApiError>;
}

pub trait HorizontalListUseCase: Send + Sync {
    fn list_horizontal(
        &self,
        context: &RequestContext,
        request: HorizontalListRequest,
    ) -> Result<HorizontalListResponse, ApiError>;
}

pub trait PageUseCase: Send + Sync {
    fn execute(
        &self,
        context: &RequestContext,
        request: PageRequest,
    ) -> Result<PageResponse, ApiError>;
}

pub trait InitUseCase: Send + Sync {
    fn init(
        &self,
        context: &RequestContext,
        request: InitRequest,
    ) -> Result<InitResponse, ApiError>;
}

pub trait FieldSchemaUseCase: Send + Sync {
    fn update_field_schema(
        &self,
        context: &RequestContext,
        request: FieldSchemaUpdateRequest,
    ) -> Result<FieldSchemaUpdateResponse, ApiError>;
}

pub trait FieldDeleteUseCase: Send + Sync {
    fn delete_field(&self, context: &RequestContext, field_id: u64) -> Result<bool, ApiError>;
}

pub trait FieldDetailUseCase: Send + Sync {
    fn get_field(
        &self,
        context: &RequestContext,
        field_id: u64,
    ) -> Result<Option<FieldCatalogEntry>, ApiError>;
}

pub fn handle_field_detail<U: FieldDetailUseCase>(
    use_case: &U,
    context: &RequestContext,
    field_id: u64,
) -> (u16, Envelope<Option<FieldCatalogEntry>>) {
    if let Err(message) = context.validate() {
        let error = ApiError::context(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    if field_id == 0 {
        let error = ApiError::validation("id must be positive");
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    match use_case.get_field(context, field_id) {
        Ok(response) => (200, Envelope::success(response)),
        Err(error) => (
            error.http_status,
            Envelope::failure(error.code, error.message_with_compensation()),
        ),
    }
}

pub fn handle_field_delete<U: FieldDeleteUseCase>(
    use_case: &U,
    context: &RequestContext,
    field_id: u64,
) -> (u16, Envelope<bool>) {
    if let Err(message) = context.validate() {
        let error = ApiError::context(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    if field_id == 0 {
        let error = ApiError::validation("id must be positive");
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    match use_case.delete_field(context, field_id) {
        Ok(response) => (200, Envelope::success(response)),
        Err(error) => (
            error.http_status,
            Envelope::failure(error.code, error.message_with_compensation()),
        ),
    }
}

pub fn handle_field_schema<U: FieldSchemaUseCase>(
    use_case: &U,
    context: &RequestContext,
    request: FieldSchemaUpdateRequest,
) -> (u16, Envelope<FieldSchemaUpdateResponse>) {
    if let Err(message) = context.validate() {
        let error = ApiError::context(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    if let Err(message) = request.validate() {
        let error = ApiError::validation(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    match use_case.update_field_schema(context, request) {
        Ok(response) => (200, Envelope::success(response)),
        Err(error) => (
            error.http_status,
            Envelope::failure(error.code, error.message_with_compensation()),
        ),
    }
}

pub fn handle_init<U: InitUseCase>(
    use_case: &U,
    context: &RequestContext,
    request: InitRequest,
) -> (u16, Envelope<InitResponse>) {
    if let Err(message) = context.validate() {
        let error = ApiError::context(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    if let Err(message) = request.validate() {
        let error = ApiError::validation(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    match use_case.init(context, request) {
        Ok(response) => (200, Envelope::success(response)),
        Err(error) => (
            error.http_status,
            Envelope::failure(error.code, error.message_with_compensation()),
        ),
    }
}

pub fn handle_page<U: PageUseCase>(
    use_case: &U,
    context: &RequestContext,
    request: PageRequest,
) -> (u16, Envelope<PageResponse>) {
    if let Err(message) = context.validate() {
        let error = ApiError::context(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    if let Err(message) = request.validate() {
        let error = ApiError::validation(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    match use_case.execute(context, request) {
        Ok(response) => (200, Envelope::success(response)),
        Err(error) => (
            error.http_status,
            Envelope::failure(error.code, error.message_with_compensation()),
        ),
    }
}

pub fn handle_metadata_query<U: MetadataQueryUseCase>(
    use_case: &U,
    context: &RequestContext,
    request: MetadataQueryRequest,
) -> (u16, Envelope<MetadataQueryResponse>) {
    if let Err(message) = context.validate() {
        let error = ApiError::context(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    if let Err(message) = request.validate() {
        let error = ApiError::validation(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    match use_case.query_metadata(context, request) {
        Ok(response) => (200, Envelope::success(response)),
        Err(error) => (
            error.http_status,
            Envelope::failure(error.code, error.message_with_compensation()),
        ),
    }
}

pub fn handle_horizontal_list<U: HorizontalListUseCase>(
    use_case: &U,
    context: &RequestContext,
    request: HorizontalListRequest,
) -> (u16, Envelope<HorizontalListResponse>) {
    if let Err(message) = context.validate() {
        let error = ApiError::context(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    if let Err(message) = request.validate() {
        let error = ApiError::validation(message);
        return (
            error.http_status,
            Envelope::failure(error.code, error.message),
        );
    }
    match use_case.list_horizontal(context, request) {
        Ok(response) => (200, Envelope::success(response)),
        Err(error) => (
            error.http_status,
            Envelope::failure(error.code, error.message_with_compensation()),
        ),
    }
}
