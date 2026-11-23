package com.kotlin.inventory

import org.springframework.stereotype.Component
import org.springframework.stereotype.Service as SpringService
import org.springframework.stereotype.*
import org.springframework.web.bind.annotation.RestController

@Component
class KotlinWidgetComponent

@SpringService("billing")
data class KotlinBillingService(val name: String)

@org.springframework.context.annotation.Configuration
sealed class KotlinConfiguration

@SpringService
abstract class KotlinAbstractService

@RestController
class KotlinApiController

@JvmInline
@SpringService
value class KotlinServiceId(val value: String)

class KotlinOuter {
    @SpringService
    class KotlinNestedService
}

class KotlinMemberShadow {
    annotation class Service
    @Service class KotlinMemberShadowedService
}

@SpringService
interface KotlinServiceContract

@SpringService
object KotlinServiceObject

@SpringService
enum class KotlinServiceState { READY }

@SpringService
annotation class KotlinServiceMarker

@KotlinComposedService class KotlinComposedCandidate

annotation class KotlinComposedService
